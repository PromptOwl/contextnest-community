/**
 * The REAL apply path — the documents→nodes writer behind
 * POST /nests/:id/publish, and the replay path for every held agent write.
 *
 * Factored out of query-routes so BOTH the immediate write (ungated, or a
 * whitelisted key) AND a confirmed held write (push-confirmation-service)
 * apply the payload through the exact same code. A held write stores its full
 * payload verbatim and replays it here on confirm, so the two paths must never
 * diverge — hence one function.
 *
 * This is a move, not a rewrite: every write still goes through createNode
 * (engine `context_create` underneath), which is what gives a pushed document
 * its version row, its vault lock, its id-occupancy check and its governance
 * rows. Nothing here hand-assembles a document.
 */
import { engineCache } from "./engine.js";
import { createNode, derivedNodeId } from "./service.js";
import { trackEvent } from "../telemetry/tracker.js";
import { config } from "../config.js";
import {
  AppError,
  ValidationError,
  ConflictError,
  VaultBusyError,
  isVaultLockTimeout,
} from "../shared/errors.js";

export interface PublishDoc {
  title: string;
  content: string;
  type?: string;
  tags?: string[];
  scope?: string;
  // Carried so a single held create (MCP context_create, POST /nests/:id/nodes)
  // replays exactly as it was submitted — the bulk endpoint never sends these.
  folder?: string;
  status?: string;
  schedule?: string;
  prime?: boolean;
}

export interface PublishPayload {
  documents?: PublishDoc[];
  context_md?: string;
}

export interface PublishResult {
  published: number;
  context_md_updated: boolean;
  node_ids: string[];
  skipped: string[];
  failed: Array<{ title: string; error: string }>;
}

/** One manifest row — what the confirm modal shows per staged doc. */
export interface PushManifestEntry {
  /** null when the title slugifies to nothing: the id is generated on apply. */
  id: string | null;
  title: string;
  type: string;
  tags: string[];
  /** Single-push GET only: the document body, for the reviewer to read. */
  content?: string;
}

/**
 * Policy validation shared by the immediate and gated paths: a disabled
 * artifact/table type fails the WHOLE batch up front (mirrors the single-create
 * path's message), before any write and before a push is even held. Malformed
 * rows are handled by applyPublish's skip semantics.
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
      id: derivedNodeId(d.title),
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
 * Apply a push: write every well-formed document (and context.md) to the nest.
 * `authorEmail` is the caller the documents are attributed to — for a confirmed
 * held push that is the SUBMITTER, not the reviewer who confirmed it.
 */
export async function applyPublish(
  nestId: string,
  body: PublishPayload,
  authorEmail: string,
): Promise<PublishResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ title: string; error: string }> = [];

  if (body.context_md) {
    // No engine op exists for context.md, so this stays a direct write; the
    // index regen keeps graph-mode reads (seeded from context.yaml) aware of
    // it. Document creation below regenerates per doc via the engine.
    const { storage } = await engineCache.get(nestId);
    await storage.writeContextMd(body.context_md);
    await storage.regenerateIndex();
  }

  for (const doc of body.documents || []) {
    if (!doc.title || !doc.content) continue;

    // Route through the canonical create (engine `context_create` underneath)
    // instead of hand-assembling documents here: same slugs, same governance
    // rows, same id-occupancy check as every other create surface. The engine
    // regenerates the index per create, where the old direct-write path
    // regenerated once for the batch — fine at agent batch sizes, and the cost
    // of a bulk path that no longer bypasses the vault lock.
    try {
      const result = await createNode(
        nestId,
        {
          title: doc.title,
          content: doc.content,
          type: doc.type,
          tags: doc.tags,
          scope: doc.scope,
          folder: doc.folder,
          status: doc.status,
          schedule: doc.schedule,
          prime: doc.prime,
        },
        authorEmail,
      );
      created.push(result.node.id);
    } catch (err) {
      // Occupied id: the legacy handler silently overwrote the existing doc
      // and restarted its history. Skip instead — republishing a folder must
      // not destroy version chains — and report it so callers can react.
      if (err instanceof ConflictError) {
        skipped.push(doc.title);
        continue;
      }
      // A busy vault fails every remaining document the same way, so stop and
      // let the caller retry the whole batch: what already landed comes back
      // as `skipped`, so the retry finishes the job instead of duplicating.
      if (isVaultLockTimeout(err) || err instanceof VaultBusyError) throw err;
      // Anything else is one document's problem — an unusable title, a type
      // the engine rejects. Report it and keep going: aborting the batch left
      // the earlier writes on disk with nothing in the response naming them.
      // Only an AppError's message is caller-facing; anything else could carry
      // a filesystem path, so it goes to the log and the caller gets the
      // generic line, same as the 500 handler would have given them.
      if (!(err instanceof AppError)) console.error("bulk publish row failed", err);
      failed.push({
        title: doc.title,
        error:
          err instanceof AppError ? err.message : "Could not create this document",
      });
    }
  }

  trackEvent("nest.publish", { nestId, count: created.length });

  return {
    published: created.length,
    context_md_updated: !!body.context_md,
    node_ids: created,
    skipped,
    failed,
  };
}
