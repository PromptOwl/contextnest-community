/**
 * Node lifecycle service — shared by REST routes and MCP tools so
 * disk + DB stay in lockstep across both surfaces. Handlers stay thin
 * (auth, parse, response shape); this module owns create/update/list.
 */
import { serializeDocument, parseDocument } from "@promptowl/contextnest-engine";
import type { ContextNode } from "@promptowl/contextnest-engine";
import { safePublishDocument } from "../governance/safe-publish.js";
import { engineCache } from "./engine.js";
import { NotFoundError } from "../shared/errors.js";
import { trackEvent } from "../telemetry/tracker.js";
import * as versions from "../governance/version-service.js";
import { syncNodeTags } from "../governance/tag-index-service.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { cancelReview, getPendingReview } from "../governance/review-service.js";
import {
  resolveCallerEmail,
  filterAccessible,
} from "../governance/access-guard.js";
import { isPublicReader } from "../shared/access.js";
import { getPendingChange } from "../governance/external-edit-service.js";
import { getDb } from "../db/client.js";
import { ANON_USER_ID } from "../shared/constants.js";

/** Reverse-lookup the auth userId from a registered email. Anonymous email → ANON. */
function userIdFromEmail(email: string): string {
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?)")
    .get(email) as { id: string } | undefined;
  return row?.id ?? ANON_USER_ID;
}

const normalizeTag = (t: string) => (t.startsWith("#") ? t : `#${t}`);

const stripUndefined = <T extends Record<string, any>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** Strip YAML frontmatter from reconstructed markdown; mirrors node.body shape. */
export function bodyOnly(nodeId: string, raw: string): string {
  try {
    return parseDocument(`${nodeId}.md`, raw, nodeId).body ?? "";
  } catch {
    return raw;
  }
}

export interface NodeResponse {
  id: string;
  title: string;
  type: string;
  tags: string[];
  status: string;
  version: number;
  author?: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  content: string;
  pendingChange?: any;
}

export function toNodeResponse(node: ContextNode): NodeResponse {
  return {
    id: node.id,
    title: node.frontmatter.title,
    type: node.frontmatter.type || "document",
    tags: node.frontmatter.tags || [],
    status: (node.frontmatter.status || "draft") as string,
    version: node.frontmatter.version || 1,
    author: node.frontmatter.author,
    description: node.frontmatter.description,
    created_at: node.frontmatter.created_at,
    updated_at: node.frontmatter.updated_at,
    content: node.body || "",
    pendingChange: node.pendingChange ?? undefined,
  };
}

export interface ListNodesFilters {
  type?: string;
  tag?: string;
  limit?: number;
}

/**
 * Per-caller node list — applies stewardship gating, public-reader rules,
 * pending-change/status resolution. Single source of truth for REST GET
 * /nests/:id/nodes, MCP context_list, and any future surface.
 */
export async function listNodesForCaller(
  nestId: string,
  userId: string,
  filters: ListNodesFilters = {},
): Promise<NodeResponse[]> {
  const { storage, versions: versionManager } = engineCache.get(nestId);
  let documents = await storage.discoverDocuments();

  // Cheap on-frontmatter filters first — narrows what we enrich below.
  if (filters.type) {
    documents = documents.filter((n) => n.frontmatter.type === filters.type);
  }
  if (filters.tag) {
    const tag = normalizeTag(filters.tag);
    documents = documents.filter((n) =>
      (n.frontmatter.tags || []).includes(tag),
    );
  }

  const userEmail = resolveCallerEmail(userId);
  const accessible = filterAccessible(nestId, userId, userEmail, documents);
  const publicReader = isPublicReader(nestId, userId);

  const enriched = await Promise.all(
    accessible.map(async (doc) => {
      const r = toNodeResponse(doc);

      if (publicReader) {
        const approved = versions.getApprovedVersion(nestId, doc.id);
        if (approved != null) {
          try {
            const raw = await versionManager.reconstructVersion(doc.id, approved);
            r.content = bodyOnly(doc.id, raw);
          } catch (err) {
            console.error("reconstructVersion failed (list)", doc.id, approved, err);
            r.content = "";
          }
          r.version = approved;
          r.status = "published";
        }
        return r;
      }

      let pending: Awaited<ReturnType<typeof getPendingChange>> = null;
      try {
        pending = await getPendingChange(nestId, doc.id);
      } catch {
        pending = null;
      }
      if (pending) {
        r.pendingChange = pending;
        r.status = "external_edit_pending";
      } else {
        r.status = versions.getDisplayStatus(nestId, r.id);
      }
      return r;
    }),
  );

  return filters.limit ? enriched.slice(0, filters.limit) : enriched;
}

/** Email-keyed wrapper for callers that don't have userId in hand (MCP tools). */
export async function listNodesForCallerByEmail(
  nestId: string,
  userEmail: string,
  filters: ListNodesFilters = {},
): Promise<NodeResponse[]> {
  return listNodesForCaller(nestId, userIdFromEmail(userEmail), filters);
}

export interface CreateNodeInput {
  title: string;
  content: string;
  type?: string;
  tags?: string[];
  scope?: string;
  status?: string;
}

export interface UpdateNodePatch {
  content?: string;
  append?: string;
  tags?: string[];
  title?: string;
  status?: string;
  changeNote?: string;
}

export interface NodeMutationResult {
  node: ContextNode;
  version: number;
}

export async function createNode(
  nestId: string,
  input: CreateNodeInput,
  userEmail: string,
): Promise<NodeMutationResult> {
  const { storage, versions: versionManager } = engineCache.get(nestId);

  const slug = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const id = `nodes/${slug}`;
  const now = new Date().toISOString();
  const tags = (input.tags || []).map(normalizeTag);

  const hasStewards = isStewardshipEnabled(nestId);
  const initialStatus = hasStewards ? "draft" : "published";
  // Ungoverned starts at v=0 so engine publish bump lands at v=1.
  const initialVersion = hasStewards ? 1 : 0;

  let node: ContextNode = {
    id,
    filePath: "",
    frontmatter: {
      title: input.title,
      type: (input.type as any) || "document",
      tags,
      status: (input.status as any) || (initialStatus as any),
      version: initialVersion,
      created_at: now,
      updated_at: now,
      metadata: { owners: ["*"], scope: input.scope || "team" },
    },
    body: input.content,
    rawContent: "",
  };
  await storage.writeDocument(id, serializeDocument(node));
  syncNodeTags(nestId, id, tags);

  let savedVersion = 1;
  if (hasStewards) {
    try {
      await versionManager.createVersion(node, userEmail);
    } catch (err) {
      console.error("VersionManager.createVersion failed (node create)", err);
    }
    versions.createVersion({
      nestId,
      nodeId: id,
      version: 1,
      content: input.content,
      author: userEmail,
      status: "draft",
      tags,
    });
  } else {
    try {
      const result = await safePublishDocument(storage, id, {
        editedBy: userEmail,
        note: "Auto-published on create (no stewards configured)",
      });
      savedVersion = result.node.frontmatter.version || 1;
      versions.createVersion({
        nestId,
        nodeId: id,
        version: savedVersion,
        content: result.node.body || "",
        author: userEmail,
        status: "published",
        tags,
      });
      versions.setApprovedVersion(nestId, id, savedVersion, userEmail);
      node = result.node;
    } catch (err) {
      console.error("publishDocument failed (node create auto-publish)", err);
      versions.createVersion({
        nestId,
        nodeId: id,
        version: 1,
        content: input.content,
        author: userEmail,
        status: "draft",
        tags,
      });
    }
  }

  trackEvent("node.create", { nestId, nodeId: id });
  return { node, version: savedVersion };
}

export async function updateNode(
  nestId: string,
  nodeId: string,
  patch: UpdateNodePatch,
  userEmail: string,
): Promise<NodeMutationResult> {
  const { storage, versions: versionManager } = engineCache.get(nestId);

  let node: ContextNode;
  try {
    node = await storage.readDocument(nodeId);
  } catch {
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }

  if (patch.content !== undefined) {
    node = { ...node, body: patch.content };
  }
  if (patch.append) {
    node = { ...node, body: (node.body || "") + "\n\n" + patch.append };
  }
  if (patch.tags) {
    const newTags = patch.tags.map(normalizeTag);
    const merged = [...new Set([...(node.frontmatter.tags || []), ...newTags])];
    node = { ...node, frontmatter: { ...node.frontmatter, tags: merged } };
  }
  if (patch.status) {
    node = { ...node, frontmatter: { ...node.frontmatter, status: patch.status as any } };
  }
  if (patch.title) {
    node = { ...node, frontmatter: { ...node.frontmatter, title: patch.title } };
  }

  const hasStewards = isStewardshipEnabled(nestId);
  const currentTags = (node.frontmatter.tags || []) as string[];

  // Editing past a pending review withdraws it — the queue entry pointed
  // at the old version; new write starts a fresh draft cycle.
  if (getPendingReview(nestId, nodeId)) {
    cancelReview({ nestId, nodeId, cancelledBy: userEmail });
  }

  let responseVersion: number;
  if (hasStewards) {
    const currentVersion = versions.getCurrentVersion(nestId, nodeId);
    const newVersion = currentVersion + 1;
    node = {
      ...node,
      frontmatter: {
        ...node.frontmatter,
        version: newVersion,
        updated_at: new Date().toISOString(),
        // Drop stale published-state checksum so the next verified read
        // doesn't flag this write as external drift.
        checksum: undefined,
      },
    };
    node = { ...node, frontmatter: stripUndefined(node.frontmatter) };
    await storage.writeDocument(nodeId, serializeDocument(node));
    syncNodeTags(nestId, nodeId, currentTags);

    try {
      await versionManager.createVersion(node, userEmail, { note: patch.changeNote });
    } catch (err) {
      console.error("VersionManager.createVersion failed (node patch)", err);
    }
    versions.createVersion({
      nestId,
      nodeId,
      version: newVersion,
      content: node.body || "",
      author: userEmail,
      status: "draft",
      tags: currentTags,
      changeNote: patch.changeNote,
    });
    responseVersion = newVersion;
  } else {
    node = {
      ...node,
      frontmatter: {
        ...node.frontmatter,
        updated_at: new Date().toISOString(),
        checksum: undefined,
      },
    };
    node = { ...node, frontmatter: stripUndefined(node.frontmatter) };
    await storage.writeDocument(nodeId, serializeDocument(node));
    syncNodeTags(nestId, nodeId, currentTags);

    let publishedVersion = (node.frontmatter.version || 0) + 1;
    try {
      const result = await safePublishDocument(storage, nodeId, {
        editedBy: userEmail,
        note: patch.changeNote || "Auto-published on edit (no stewards)",
      });
      publishedVersion = result.node.frontmatter.version || publishedVersion;
      node = result.node;
    } catch (err) {
      console.error("publishDocument failed (node patch auto-publish)", err);
    }
    versions.createVersion({
      nestId,
      nodeId,
      version: publishedVersion,
      content: node.body || "",
      author: userEmail,
      status: "published",
      tags: currentTags,
      changeNote: patch.changeNote,
    });
    versions.setApprovedVersion(nestId, nodeId, publishedVersion, userEmail);
    responseVersion = publishedVersion;
  }

  return { node, version: responseVersion };
}
