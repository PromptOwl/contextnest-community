/**
 * Node lifecycle service — shared by REST routes and MCP tools so
 * disk + DB stay in lockstep across both surfaces. Handlers stay thin
 * (auth, parse, response shape); this module owns create/update/list.
 */
import {
  serializeDocument,
  parseDocument,
} from "@promptowl/contextnest-engine";
import type { ContextNode } from "@promptowl/contextnest-engine";
import { rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safePublishDocument } from "../governance/safe-publish.js";
import { engineCache } from "./engine.js";
import {
  AppError,
  NotFoundError,
  LockedError,
  ValidationError,
  ConflictError,
} from "../shared/errors.js";
import { trackEvent } from "../telemetry/tracker.js";
import * as versions from "../governance/version-service.js";
import { syncNodeTags } from "../governance/tag-index-service.js";
import { isStewardshipEnabled, resolveNestPath } from "../nests/service.js";
import { getPendingReview } from "../governance/review-service.js";
import {
  resolveCallerEmail,
  filterAccessible,
} from "../governance/access-guard.js";
import { isPublicReader, resolveNestPermission } from "../shared/access.js";
import {
  listUserGrants,
  grantCoversNode,
} from "../governance/grants-service.js";
import { getPendingChange } from "../governance/external-edit-service.js";
import { getDb } from "../db/client.js";
import { ANON_USER_ID } from "../shared/constants.js";

/** Reverse-lookup the auth userId from a registered email. Anonymous email → ANON. */
async function userIdFromEmail(email: string): Promise<string> {
  const db = getDb();
  const row = (await db.get(
    "SELECT id FROM users WHERE LOWER(email) = LOWER(?)",
    [email]
  )) as { id: string } | undefined;
  return row?.id ?? ANON_USER_ID;
}

const normalizeTag = (t: string) => (t.startsWith("#") ? t : `#${t}`);

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Slugify + validate a folder path into id segments. Shared by create and
 * move so both enforce the same depth/length bounds and the same traversal
 * defense (each segment slugified independently — "../" collapses to "-",
 * empty segments drop).
 */
function folderToSegments(folder: string): string[] {
  const segments = folder.split("/").map(slugify).filter(Boolean);
  if (segments.length > 8) {
    throw new ValidationError("folder may nest at most 8 levels deep");
  }
  if (segments.some((seg) => seg.length > 100)) {
    throw new ValidationError(
      "each folder or title segment must be at most 100 characters",
    );
  }
  return segments;
}

const stripUndefined = <T extends Record<string, any>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

// Serialize writes per node. Without this, concurrent saves (rapid autosave,
// two tabs, MCP + REST) each read the same base version and append "base+1",
// producing duplicate/swapped version numbers that break the engine diff
// chain and split the DB count from history.yaml. Chaining a node's writes
// through one promise makes read→write→version-append atomic. In-process is
// enough: single-process server over local SQLite + filesystem.
const nodeWriteChains = new Map<string, Promise<unknown>>();
function withNodeWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = (nodeWriteChains.get(key) ?? Promise.resolve()).catch(() => {});
  const run = prev.then(fn);
  nodeWriteChains.set(key, run);
  void run
    .catch(() => {})
    .finally(() => {
      if (nodeWriteChains.get(key) === run) nodeWriteChains.delete(key);
    });
  return run;
}

// Convert any thrown value into a client-safe error. Domain AppErrors
// (NotFound/Locked/Validation…) carry intentional, user-facing messages and
// pass through untouched. Anything else — engine faults, chain-break/integrity
// errors, filesystem/DB internals — is logged server-side and replaced with a
// generic message, so raw internals (paths, chain hashes, stack traces) never
// reach the API response OR the MCP result (both share this service).
function toSafeError(err: unknown, context: string, message: string): AppError {
  if (err instanceof AppError) return err;
  console.error(`${context}:`, err);
  return new AppError(500, message);
}

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
  /** Creator email — frontmatter author when present, else the author of the
   *  node's first version. Null for old imported docs with neither. */
  author?: string | null;
  /** Everyone else with a hand in the doc: distinct node_versions authors
   *  UNION document-scope grant holders, minus the author, sorted. */
  collaborators?: string[];
  description?: string;
  created_at?: string;
  updated_at?: string;
  content: string;
  pendingChange?: any;
  /** Orchestrator hint for runnable nodes (type agent/skill) — free-form
   *  cron/interval string, opaque to the server. */
  schedule?: string;
}

/** Node types an orchestrator can fetch and run; only these carry schedule. */
export const RUNNABLE_NODE_TYPES = ["agent", "skill"] as const;
export function isRunnableType(type: string | undefined): boolean {
  return (RUNNABLE_NODE_TYPES as readonly string[]).includes(type || "");
}

export function toNodeResponse(node: ContextNode): NodeResponse {
  const fm = node.frontmatter;
  // Coerce string-ish fields. YAML parses bare values by type, so a
  // frontmatter line like `title: 123` arrives as a number — clients then
  // call `.trim()`/`.toLowerCase()` on it and crash. Normalize at the API
  // boundary so every surface (editor, list search, MCP) gets strings.
  const title =
    fm.title === undefined || fm.title === null ? "" : String(fm.title);
  const tags = Array.isArray(fm.tags) ? fm.tags.map((t) => String(t)) : [];
  return {
    id: node.id,
    title,
    type: fm.type || "document",
    tags,
    status: (fm.status || "draft") as string,
    version: fm.version || 1,
    author: fm.author,
    description: fm.description,
    created_at: fm.created_at,
    updated_at: fm.updated_at,
    content: node.body || "",
    pendingChange: node.pendingChange ?? undefined,
    // Same YAML-coercion rule as title above: `schedule: 123` parses as a
    // number — normalize to string at the API boundary.
    schedule:
      (fm.metadata as any)?.schedule != null
        ? String((fm.metadata as any).schedule)
        : undefined,
  };
}

export interface NodeAuthorship {
  author: string | null;
  collaborators: string[];
}

/**
 * Batch author + collaborator resolution for a set of nodes.
 *
 * Author = the node's frontmatter author (passed in by the caller) or, when
 * frontmatter lacks it (imports, older docs), the author of the node's first
 * version. Collaborators = distinct node_versions authors UNION document-scope
 * grant holders, MINUS the author, sorted.
 *
 * Exactly two queries regardless of node count (no per-node N+1): one grouped
 * pass over node_versions — per (node, author) the earliest version that
 * author touched, so the overall-earliest author doubles as the creator
 * fallback — and one pass over document grants joined to users for emails.
 * Both are plain GROUP BY / JOIN SQL, portable across SQLite and Postgres.
 * `system:*` version authors (auto-publish bumps, drift scans) mirror
 * machine activity, not a person — they're excluded.
 */
export async function resolveAuthorship(
  nestId: string,
  nodes: Array<{ id: string; frontmatterAuthor?: string | null }>,
): Promise<Map<string, NodeAuthorship>> {
  const result = new Map<string, NodeAuthorship>();
  if (nodes.length === 0) return result;
  const db = getDb();

  // Single-node fast path (the detail endpoint) narrows both scans by id;
  // the list path scans the nest once, grouped.
  const single = nodes.length === 1 ? nodes[0].id : null;
  const versionRows = (await db.all(
    `SELECT node_id, author, MIN(version) AS first_version
       FROM node_versions
      WHERE nest_id = ?${single ? " AND node_id = ?" : ""}
        AND author IS NOT NULL AND author NOT LIKE 'system:%'
      GROUP BY node_id, author`,
    single ? [nestId, single] : [nestId],
  )) as Array<{ node_id: string; author: string; first_version: number }>;
  const grantRows = (await db.all(
    `SELECT g.target AS node_id, u.email AS email
       FROM grants g
       JOIN users u ON u.id = g.user_id
      WHERE g.nest_id = ? AND g.target_type = 'document'${single ? " AND g.target = ?" : ""}`,
    single ? [nestId, single] : [nestId],
  )) as Array<{ node_id: string; email: string }>;

  const editorsByNode = new Map<string, Array<{ author: string; first: number }>>();
  for (const r of versionRows) {
    let list = editorsByNode.get(r.node_id);
    if (!list) editorsByNode.set(r.node_id, (list = []));
    list.push({ author: r.author, first: Number(r.first_version) });
  }
  const granteesByNode = new Map<string, string[]>();
  for (const g of grantRows) {
    let list = granteesByNode.get(g.node_id);
    if (!list) granteesByNode.set(g.node_id, (list = []));
    list.push(g.email);
  }

  for (const n of nodes) {
    const editors = editorsByNode.get(n.id) ?? [];
    const firstAuthor = editors.length
      ? editors.reduce((a, b) => (b.first < a.first ? b : a)).author
      : null;
    const author = n.frontmatterAuthor || firstAuthor;
    const authorKey = author ? author.toLowerCase() : null;
    // Distinct (case-insensitive), author excluded, sorted.
    const seen = new Set<string>();
    const collaborators: string[] = [];
    for (const email of [
      ...editors.map((e) => e.author),
      ...(granteesByNode.get(n.id) ?? []),
    ]) {
      const key = email.toLowerCase();
      if (key === authorKey || seen.has(key)) continue;
      seen.add(key);
      collaborators.push(email);
    }
    collaborators.sort((a, b) => a.localeCompare(b));
    result.set(n.id, { author: author ?? null, collaborators });
  }
  return result;
}

export interface ListNodesFilters {
  /** One type, or several (e.g. runnable types) to keep. */
  type?: string | readonly string[];
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
  filters: ListNodesFilters = {}
): Promise<NodeResponse[]> {
  const { storage, versions: versionManager } = await engineCache.get(nestId);
  let documents = await storage.discoverDocuments();

  // Cheap on-frontmatter filters first — narrows what we enrich below, so the
  // per-node governance/version work never runs on docs we'd discard anyway.
  if (filters.type) {
    const wanted = new Set(
      Array.isArray(filters.type) ? filters.type : [filters.type]
    );
    documents = documents.filter((n) => wanted.has(n.frontmatter.type));
  }
  if (filters.tag) {
    const tag = normalizeTag(filters.tag);
    documents = documents.filter((n) =>
      (n.frontmatter.tags || []).includes(tag)
    );
  }

  const userEmail = await resolveCallerEmail(userId);
  let accessible = await filterAccessible(nestId, userId, userEmail, documents);

  // Share grants: a caller with NO nest-wide permission sees exactly the
  // documents their grants cover — never the whole list. filterAccessible's
  // stewardship-OFF path returns the entire nest (open read), which must NOT
  // apply to a non-member, so narrow it to their grant-covered docs. With
  // stewardship ON, filterAccessible already restricted to
  // steward-accessible + grant-covered, so there's nothing to narrow.
  if (
    (await resolveNestPermission(nestId, userId)) === "none" &&
    !(await isStewardshipEnabled(nestId))
  ) {
    const grants = await listUserGrants(nestId, userId);
    accessible = grants.length
      ? documents.filter((d) => grantCoversNode(grants, d.id))
      : accessible;
  }
  const publicReader = await isPublicReader(nestId, userId);

  // Author + collaborators for exactly the post-filter set — two batched
  // queries for the whole list (see resolveAuthorship), never per-node.
  // Withheld from public readers: the roster is the nest's people, not its
  // published content, so it stays behind the same gate as the body. They
  // keep the frontmatter-only `author` toNodeResponse already set.
  const authorship = publicReader
    ? null
    : await resolveAuthorship(
        nestId,
        accessible.map((d) => ({
          id: d.id,
          frontmatterAuthor: d.frontmatter.author ?? null,
        })),
      );

  const enriched = await Promise.all(
    accessible.map(async (doc) => {
      const r = toNodeResponse(doc);
      const people = authorship?.get(doc.id);
      if (people) {
        r.author = people.author;
        r.collaborators = people.collaborators;
      }

      if (publicReader) {
        const approved = await versions.getApprovedVersion(nestId, doc.id);
        if (approved != null) {
          try {
            const raw = await versionManager.reconstructVersion(
              doc.id,
              approved
            );
            r.content = bodyOnly(doc.id, raw);
          } catch (err) {
            console.error(
              "reconstructVersion failed (list)",
              doc.id,
              approved,
              err
            );
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
        r.status = await versions.getDisplayStatus(nestId, r.id);
      }
      return r;
    })
  );

  return filters.limit ? enriched.slice(0, filters.limit) : enriched;
}

/** Email-keyed wrapper for callers that don't have userId in hand (MCP tools). */
export async function listNodesForCallerByEmail(
  nestId: string,
  userEmail: string,
  filters: ListNodesFilters = {}
): Promise<NodeResponse[]> {
  return listNodesForCaller(nestId, await userIdFromEmail(userEmail), filters);
}

export interface CreateNodeInput {
  title: string;
  content: string;
  type?: string;
  tags?: string[];
  scope?: string;
  status?: string;
  /** Explicit node id (e.g. "nodes/foo"). When omitted the id is derived from
   *  the title slug. Used by derived/system nodes that need a deterministic,
   *  collision-free id independent of the human-readable title. */
  id?: string;
  /** Orchestrator schedule (cron/interval string, opaque to the server).
   *  Only valid for runnable types (agent/skill). */
  schedule?: string;
  /** Folder path under nodes/ (e.g. "gtm/deals"). Each segment is slugified;
   *  storage and read/update/delete already handle nested ids, only creation
   *  was flat. Ignored when an explicit id is given. */
  folder?: string;
  /** Optional note recorded on the initial version (e.g. the GitHub sync
   *  connector's "Synced from github.com/{repo}@{sha}"). */
  changeNote?: string;
}

export interface UpdateNodePatch {
  content?: string;
  append?: string;
  tags?: string[];
  title?: string;
  status?: string;
  changeNote?: string;
  /** Orchestrator schedule — runnable types only; empty string clears it. */
  schedule?: string;
}

export interface NodeMutationResult {
  node: ContextNode;
  version: number;
}

export async function createNode(
  nestId: string,
  input: CreateNodeInput,
  userEmail: string
): Promise<NodeMutationResult> {
  const { storage, versions: versionManager } = await engineCache.get(nestId);

  const slug = slugify(input.title);
  // Slugifying per segment means "../x" or absolute paths can never escape
  // the vault — traversal characters collapse to "-" and empty segments drop.
  // An explicit id wins outright: folder is documented as ignored then, so
  // it isn't derived or validated either.
  let id = input.id;
  if (!id) {
    const folderSegments = folderToSegments(input.folder ?? "");
    // Bound the title slug too, so an overlong title fails as a clean 400
    // instead of an ENAMETOOLONG surfacing as an unhandled 500 at
    // storage.writeDocument.
    if ([...folderSegments, slug].some((seg) => seg.length > 100)) {
      throw new ValidationError(
        "each folder or title segment must be at most 100 characters"
      );
    }
    id =
      folderSegments.length > 0
        ? `nodes/${folderSegments.join("/")}/${slug}`
        : `nodes/${slug}`;
  }
  const now = new Date().toISOString();
  const tags = (input.tags || []).map(normalizeTag);

  if (input.schedule !== undefined && !isRunnableType(input.type)) {
    throw new ValidationError(
      `schedule is only valid for runnable node types (${RUNNABLE_NODE_TYPES.join(
        ", "
      )})`
    );
  }

  const hasStewards = await isStewardshipEnabled(nestId);
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
      metadata: {
        owners: ["*"],
        scope: input.scope || "team",
        ...(input.schedule ? { schedule: input.schedule } : {}),
      } as any,
    },
    body: input.content,
    rawContent: "",
  };
  await storage.writeDocument(id, serializeDocument(node));
  await syncNodeTags(nestId, id, tags);

  let savedVersion = 1;
  if (hasStewards) {
    try {
      await versionManager.createVersion(node, userEmail, {
        note: input.changeNote,
      });
    } catch (err) {
      console.error("VersionManager.createVersion failed (node create)", err);
    }
    await versions.createVersion({
      nestId,
      nodeId: id,
      version: 1,
      content: input.content,
      author: userEmail,
      status: "draft",
      changeNote: input.changeNote,
      tags,
    });
  } else {
    try {
      const result = await safePublishDocument(storage, id, {
        editedBy: userEmail,
        note: input.changeNote || "Auto-published on create (no stewards configured)",
      });
      savedVersion = result.node.frontmatter.version || 1;
      await versions.createVersion({
        nestId,
        nodeId: id,
        version: savedVersion,
        content: result.node.body || "",
        author: userEmail,
        status: "published",
        changeNote: input.changeNote,
        tags,
      });
      await versions.setApprovedVersion(nestId, id, savedVersion, userEmail);
      node = result.node;
    } catch (err) {
      console.error("publishDocument failed (node create auto-publish)", err);
      await versions.createVersion({
        nestId,
        nodeId: id,
        version: 1,
        content: input.content,
        author: userEmail,
        status: "draft",
        changeNote: input.changeNote,
        tags,
      });
    }
  }

  await trackEvent("node.create", { nestId, nodeId: id });
  return { node, version: savedVersion };
}

/**
 * Register the documents already present in an imported folder.
 *
 * On import the nest row exists but the governance DB is empty, so the
 * existing on-disk documents have no version/approved/tag rows. Without
 * them the docs still list (discovery is disk-based) but show as "draft"
 * and editing wouldn't continue from their real version.
 *
 * This walks the folder's documents once and, for each, runs the engine's
 * publish (safePublishDocument) so the doc gains a published checksum + a
 * version-chain keyframe and context.yaml is regenerated — exactly the
 * no-stewards auto-publish path createNode uses. That is what makes an
 * imported doc usable by AI: GraphQueryEngine/Resolver only return
 * *published* documents, and public/shared readers reconstruct the approved
 * body from the keyframe. Any .versions history copied on import is preserved;
 * publish appends to the chain. Each doc is then seeded with a
 * published+approved governance row at its published version, plus its tag
 * index. Idempotent: docs that already carry a version row are skipped, so
 * re-running is safe.
 *
 * Returns the number of documents newly registered.
 */
export async function registerImportedDocuments(
  nestId: string,
  userEmail: string
): Promise<number> {
  const { storage } = await engineCache.get(nestId);
  let docs: ContextNode[];
  try {
    docs = await storage.discoverDocuments();
  } catch (err) {
    console.error("registerImportedDocuments: discovery failed", nestId, err);
    return 0;
  }

  let registered = 0;
  for (let doc of docs) {
    const nodeId = doc.id;
    if ((await versions.getCurrentVersion(nestId, nodeId)) > 0) continue; // already tracked

    // Imported markdown often ships without a frontmatter `title:`, which
    // would list the doc as untitled. Fall back to the filename (leaf of the
    // node id) and persist it to disk BEFORE publish so the title sticks.
    if (!doc.frontmatter?.title) {
      const title = nodeId.split("/").pop() || nodeId;
      doc = { ...doc, frontmatter: { ...doc.frontmatter, title } };
      try {
        await storage.writeDocument(nodeId, serializeDocument(doc));
      } catch (err) {
        console.error("import: failed to persist filename title", nodeId, err);
      }
    }

    const rawTags = Array.isArray(doc.frontmatter?.tags)
      ? doc.frontmatter.tags
      : [];
    const tags = rawTags.map((t) => normalizeTag(String(t)));

    // Publish in the engine so the doc is AI-visible (published status +
    // checksum + keyframe). Falls back to the on-disk version if publish
    // fails, so the doc still lists + edits from a sane base.
    const fmVersion = Number(doc.frontmatter?.version);
    let version = Number.isFinite(fmVersion) && fmVersion > 0 ? fmVersion : 1;
    let content = doc.body || "";
    try {
      const result = await safePublishDocument(storage, nodeId, {
        editedBy: userEmail,
        note: "Imported from existing folder",
      });
      version = result.node.frontmatter.version || version;
      content = result.node.body || content;
    } catch (err) {
      console.error(
        "safePublishDocument failed (import register)",
        nodeId,
        err
      );
    }

    await versions.createVersion({
      nestId,
      nodeId,
      version,
      content,
      author: userEmail,
      status: "published",
      changeNote: "Imported from existing folder",
      tags,
    });
    await versions.setApprovedVersion(nestId, nodeId, version, userEmail);
    await syncNodeTags(nestId, nodeId, tags);
    registered++;
  }

  await trackEvent("nest.import.documents", { nestId, registered });
  return registered;
}

export async function updateNode(
  nestId: string,
  nodeId: string,
  patch: UpdateNodePatch,
  userEmail: string
): Promise<NodeMutationResult> {
  return withNodeWriteLock(`${nestId}::${nodeId}`, async () => {
    try {
      const { storage, versions: versionManager } = await engineCache.get(
        nestId
      );

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
        const merged = [
          ...new Set([...(node.frontmatter.tags || []), ...newTags]),
        ];
        node = { ...node, frontmatter: { ...node.frontmatter, tags: merged } };
      }
      if (patch.status) {
        node = {
          ...node,
          frontmatter: { ...node.frontmatter, status: patch.status as any },
        };
      }
      if (patch.title) {
        node = {
          ...node,
          frontmatter: { ...node.frontmatter, title: patch.title },
        };
      }
      if (patch.schedule !== undefined) {
        if (!isRunnableType(node.frontmatter.type)) {
          throw new ValidationError(
            `schedule is only valid for runnable node types (${RUNNABLE_NODE_TYPES.join(
              ", "
            )})`
          );
        }
        const metadata = { ...(node.frontmatter.metadata as any) };
        if (patch.schedule === "") delete metadata.schedule;
        else metadata.schedule = patch.schedule;
        node = { ...node, frontmatter: { ...node.frontmatter, metadata } };
      }

      const hasStewards = await isStewardshipEnabled(nestId);
      const currentTags = (node.frontmatter.tags || []) as string[];

      // Stewardship lock: a node with an open review request is frozen. The
      // reviewer is evaluating a specific version, so edits are rejected (423)
      // until the review is approved or rejected — that's the only path that
      // releases the lock.
      if (hasStewards && (await getPendingReview(nestId, nodeId))) {
        throw new LockedError(
          "This document is awaiting steward review and is locked. Approve or reject the pending review before editing."
        );
      }

      let responseVersion: number;
      if (hasStewards) {
        const currentVersion = await versions.getCurrentVersion(nestId, nodeId);
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
        await syncNodeTags(nestId, nodeId, currentTags);

        // Persist to the engine history FIRST, then mirror into the DB. If the
        // engine append fails (e.g. a broken diff chain), rethrow so we DON'T
        // record a DB version the engine never stored — that silent swallow is
        // what let node_versions drift ahead of history.yaml (DB v19 vs v15).
        try {
          await versionManager.createVersion(node, userEmail, {
            note: patch.changeNote,
          });
        } catch (err) {
          console.error(
            "VersionManager.createVersion failed (node patch)",
            err
          );
          throw err;
        }
        await versions.createVersion({
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
        await syncNodeTags(nestId, nodeId, currentTags);

        let publishedVersion = (node.frontmatter.version || 0) + 1;
        // Publish through the engine FIRST; only mirror into the DB once it
        // actually landed. Rethrow on failure — swallowing here is what let
        // node_versions climb past what history.yaml stored (DB v19 vs v15).
        try {
          const result = await safePublishDocument(storage, nodeId, {
            editedBy: userEmail,
            note: patch.changeNote || "Auto-published on edit (no stewards)",
          });
          publishedVersion =
            result.node.frontmatter.version || publishedVersion;
          node = result.node;
        } catch (err) {
          console.error(
            "publishDocument failed (node patch auto-publish)",
            err
          );
          throw err;
        }
        await versions.createVersion({
          nestId,
          nodeId,
          version: publishedVersion,
          content: node.body || "",
          author: userEmail,
          status: "published",
          tags: currentTags,
          changeNote: patch.changeNote,
        });
        await versions.setApprovedVersion(
          nestId,
          nodeId,
          publishedVersion,
          userEmail
        );
        responseVersion = publishedVersion;
      }

      return { node, version: responseVersion };
    } catch (err) {
      // One boundary: domain errors (NotFound/Locked/Validation) pass through
      // with their intended messages; engine/internal faults become a generic
      // safe message. Same result for REST and MCP callers — neither leaks
      // internals.
      throw toSafeError(
        err,
        `updateNode failed (${nestId}/${nodeId})`,
        "Couldn't save your changes. Please reload the document and try again."
      );
    }
  });
}

/** Mirror of annotations/service.ts derivedAnnotationsId — duplicated here
 *  because importing it would close the annotations→nodes import cycle. */
function derivedIdOf(sourceNodeId: string): string {
  return `nodes/${sourceNodeId.replace(/^nodes\//, "")}--annotations`;
}

export interface MoveNodeResult {
  node: ContextNode;
  previousId: string;
}

/**
 * Move a node to another folder, preserving everything keyed to its id:
 * version history (DB rows + on-disk .versions chain), review state,
 * approved-version pin, annotations, comments, workflow edges, document
 * grants, document-scoped stewards, and run traces. The id changes
 * (nodes/<folder…>/<leaf>); the leaf slug and title do not, so [[Title]]
 * wiki-links keep resolving.
 *
 * Folder grants intentionally do NOT follow the doc — they cover a path
 * prefix, so a doc moved out of a shared folder leaves that share and a
 * doc moved into one joins it. That asymmetry is the feature.
 */
export async function moveNode(
  nestId: string,
  nodeId: string,
  folder: string,
  userEmail: string,
): Promise<MoveNodeResult> {
  const { storage } = await engineCache.get(nestId);

  let node: ContextNode;
  try {
    node = await storage.readDocument(nodeId);
  } catch {
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }

  // Same freeze as edit/delete: a node under open review is what the
  // reviewer is looking at — its identity can't change mid-review.
  if ((await isStewardshipEnabled(nestId)) && (await getPendingReview(nestId, nodeId))) {
    throw new LockedError(
      "This document is awaiting steward review and is locked. Approve or reject the pending review before moving.",
    );
  }

  const leaf = nodeId.split("/").pop()!;
  const segments = folderToSegments(folder);
  const newId =
    segments.length > 0 ? `nodes/${segments.join("/")}/${leaf}` : `nodes/${leaf}`;
  if (newId === nodeId) return { node, previousId: nodeId };

  try {
    await storage.readDocument(newId);
    throw new ConflictError(
      `A document already exists at that location: ${newId}`,
    );
  } catch (err) {
    if (err instanceof ConflictError) throw err;
    /* target free — proceed */
  }

  const moved: ContextNode = {
    ...node,
    id: newId,
    frontmatter: {
      ...node.frontmatter,
      updated_at: new Date().toISOString(),
    },
  };
  await storage.writeDocument(newId, serializeDocument(moved));

  // Carry the engine's on-disk version chain (.versions/<leaf>/ next to the
  // doc) so reconstructVersion keeps working for pre-move versions. Layout is
  // engine-owned, so this is best-effort: if the chain isn't where the
  // structured layout puts it (e.g. flat imported nests), history still
  // serves from the governance DB rows migrated below.
  try {
    const nestPath = resolveNestPath(nestId);
    const oldChain = join(nestPath, dirname(nodeId), ".versions", leaf);
    const newChain = join(nestPath, dirname(newId), ".versions", leaf);
    if (oldChain !== newChain) {
      await mkdir(dirname(newChain), { recursive: true });
      await rename(oldChain, newChain);
    }
  } catch {
    /* no on-disk chain to carry */
  }

  await storage.deleteDocument(nodeId);

  // Rewrite every table that keys on the node id — the same reference set
  // DELETE purges, plus workflow edges, grants, and run traces. One
  // transaction: a half-moved node would be worse than a failed move.
  const oldDerived = derivedIdOf(nodeId);
  const newDerived = derivedIdOf(newId);
  const db = getDb();
  await db.transaction(async (tx) => {
    for (const [table, column] of [
      ["node_versions", "node_id"],
      ["review_requests", "node_id"],
      ["approved_versions", "node_id"],
      ["annotation_threads", "node_id"],
      ["comments", "node_id"],
      ["node_tag_index", "node_id"],
    ] as const) {
      await tx.run(
        `UPDATE ${table} SET ${column} = ? WHERE nest_id = ? AND ${column} = ?`,
        [newId, nestId, nodeId],
      );
      await tx.run(
        `UPDATE ${table} SET ${column} = ? WHERE nest_id = ? AND ${column} = ?`,
        [newDerived, nestId, oldDerived],
      );
    }
    await tx.run(
      `UPDATE stewards SET node_pattern = ?
       WHERE nest_id = ? AND scope = 'document' AND node_pattern = ?`,
      [newId, nestId, nodeId],
    );
    await tx.run(
      `UPDATE grants SET target = ?
       WHERE nest_id = ? AND target_type = 'document' AND target = ?`,
      [newId, nestId, nodeId],
    );
    await tx.run(
      "UPDATE edges SET from_node = ? WHERE nest_id = ? AND from_node = ?",
      [newId, nestId, nodeId],
    );
    await tx.run(
      "UPDATE edges SET to_node = ? WHERE nest_id = ? AND to_node = ?",
      [newId, nestId, nodeId],
    );
    await tx.run(
      "UPDATE runs SET agent_node = ? WHERE nest_id = ? AND agent_node = ?",
      [newId, nestId, nodeId],
    );
    await tx.run(
      `UPDATE run_steps SET node_id = ?
       WHERE node_id = ? AND run_id IN (SELECT id FROM runs WHERE nest_id = ?)`,
      [newId, nodeId, nestId],
    );
  });

  // The derived annotations node (if any) lives beside its source — move its
  // storage doc too. Best-effort, same as delete's handling of it.
  try {
    const derivedDoc = await storage.readDocument(oldDerived);
    await storage.writeDocument(
      newDerived,
      serializeDocument({ ...derivedDoc, id: newDerived }),
    );
    await storage.deleteDocument(oldDerived);
  } catch {
    /* no derived annotations node */
  }

  await trackEvent("node.move", { nestId, nodeId, newId });
  return { node: moved, previousId: nodeId };
}
