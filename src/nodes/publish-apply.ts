/**
 * The REAL ctx-push apply path — the documents→nodes writer behind
 * POST /nests/:id/publish.
 *
 * Factored out of query-routes so BOTH the immediate publish (ungated, or a
 * whitelisted key) AND a confirmed pending push (push-confirmation-service)
 * apply the payload through the exact same code. A gated push stores its full
 * payload verbatim and replays it here on confirm, so the two paths must never
 * diverge — hence one function.
 */
import { serializeDocument } from "@promptowl/contextnest-engine";
import type { ContextNode } from "@promptowl/contextnest-engine";
import { engineCache } from "./engine.js";
import { syncNodeTags } from "../governance/tag-index-service.js";
import { trackEvent } from "../telemetry/tracker.js";
import { config } from "../config.js";
import { ValidationError } from "../shared/errors.js";

export interface PublishDoc {
  title: string;
  content: string;
  type?: string;
  tags?: string[];
  scope?: string;
}

export interface PublishPayload {
  documents?: PublishDoc[];
  context_md?: string;
}

export interface PublishResult {
  published: number;
  context_md_updated: boolean;
  node_ids: string[];
}

/** One manifest row — what the confirm modal shows per staged doc. */
export interface PushManifestEntry {
  id: string;
  title: string;
  type: string;
  tags: string[];
}

/** Derive the node id (storage path) a document title will publish to. */
export function docNodeId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `nodes/${slug}`;
}

/**
 * Policy validation shared by the immediate and gated paths: a disabled
 * artifact/table type fails the WHOLE batch up front (mirrors the single-create
 * path's message). Malformed rows are handled by applyPublish's skip semantics.
 */
export function validatePublishPayload(body: PublishPayload): void {
  if (!body.documents?.length && !body.context_md) {
    throw new ValidationError("documents array or context_md is required");
  }
  for (const doc of body.documents || []) {
    const t = doc.type || "document";
    if (t === "artifact" && !config.TYPE_ARTIFACT_ENABLED) {
      throw new ValidationError("Artifact nodes are disabled on this server");
    }
    if (t === "table" && !config.TYPE_TABLE_ENABLED) {
      throw new ValidationError("Table nodes are disabled on this server");
    }
  }
}

/** Build the confirm-modal manifest for a payload (title·type·tags per doc). */
export function buildManifest(body: PublishPayload): PushManifestEntry[] {
  return (body.documents || [])
    .filter((d) => d.title && d.content)
    .map((d) => ({
      id: docNodeId(d.title),
      title: d.title,
      type: d.type || "document",
      tags: (d.tags || []).map((t) => (t.startsWith("#") ? t : `#${t}`)),
    }));
}

/** Count the docs that will actually be written (title + content present). */
export function countPublishDocs(body: PublishPayload): number {
  return (body.documents || []).filter((d) => d.title && d.content).length;
}

/**
 * Apply a push: write every well-formed document (and context.md) to the nest,
 * sync tags, regenerate the index. Returns what landed.
 */
export async function applyPublish(
  nestId: string,
  body: PublishPayload,
): Promise<PublishResult> {
  const { storage } = await engineCache.get(nestId);
  const created: string[] = [];

  if (body.context_md) {
    await storage.writeContextMd(body.context_md);
  }

  for (const doc of body.documents || []) {
    if (!doc.title || !doc.content) continue;

    const id = docNodeId(doc.title);
    const now = new Date().toISOString();
    const tags =
      doc.tags?.map((t) => (t.startsWith("#") ? t : `#${t}`)) || [];

    const node: ContextNode = {
      id,
      filePath: "",
      frontmatter: {
        title: doc.title,
        type: (doc.type as any) || "document",
        tags,
        status: "draft",
        version: 1,
        created_at: now,
        updated_at: now,
        metadata: {
          owners: ["*"],
          scope: doc.scope || "team",
        },
      },
      body: doc.content,
      rawContent: "",
    };

    const serialized = serializeDocument(node);
    await storage.writeDocument(id, serialized);
    await syncNodeTags(nestId, id, tags);
    created.push(id);
  }

  // Once for the batch, not per document — context.yaml must learn about these
  // writes so graph-mode reads (which seed from that index) can see them.
  if (created.length > 0 || body.context_md) await storage.regenerateIndex();

  trackEvent("nest.publish", { nestId, count: created.length });

  return {
    published: created.length,
    context_md_updated: !!body.context_md,
    node_ids: created,
  };
}
