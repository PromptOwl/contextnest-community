/**
 * External Edit Service — surfaces direct filesystem edits as pending
 * approvals (bridge-function-spec Story 3.1, hootie-inbox-spec §4).
 *
 * Wraps the engine's drift + suggestion primitives so the rest of the
 * community server can ignore PESWG hash-chain mechanics and just call
 * scan / list / approve / reject.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import {
  detectDrift,
  stageSuggestion,
  approveSuggestion,
  rejectSuggestion,
  listSuggestions,
  readSuggestion,
  parseDocument,
  VersionManager,
  computeContentHash,
  getChecksumContent,
  type ContextNode,
  type RbacHook,
  type SuggestionMeta,
  type PendingChange,
  type NestStorage,
} from "@promptowl/contextnest-engine";
import { engineCache } from "../nodes/engine.js";
import { getDb } from "../db/client.js";
import { config } from "../config.js";

/** Community-tier RBAC stub.
 *
 * The community server enforces nest-level permissions at the route
 * middleware layer, so by the time the engine is called the actor is
 * already authorized. The engine still needs an `RbacHook` shape — we
 * grant doc-owner uniformly; czar paths are not used (community runs
 * standard tier only). */
const communityRbac: RbacHook = {
  isCzar: () => false,
  canIngest: () => true,
  isDocOwner: () => true,
};

/** What a pending external edit looks like over the wire. */
export interface ExternalEditEntry {
  suggestion_id: string;
  nest_id: string;
  document_id: string;
  source: SuggestionMeta["source"];
  detected_at: string;
  actor: string;
  target_hash: string;
  proposed_hash: string;
  note?: string;
  patch?: string;
}

/** Resolve a document's on-disk path inside a nest. */
function docPath(nestId: string, documentId: string): string {
  return join(config.DATA_ROOT, "nests", nestId, `${documentId}.md`);
}

/** Read raw file bytes; null if the file is gone (treat as deletion drift). */
async function readRaw(nestId: string, documentId: string): Promise<string | null> {
  try {
    return await readFile(docPath(nestId, documentId), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Reproduce engine `approveSuggestion`'s view of the approved base: the
 * latest entry in history.yaml reconstructed forward from the nearest
 * keyframe via diffs (engine `loadApprovedBase`). We need exactly this
 * content as the patch's `approved` side; otherwise the patch context
 * lines reference an older keyframe and `applyPatch` returns false.
 */
async function loadChainHead(
  storage: NestStorage,
  documentId: string,
): Promise<{ version: number; content: string } | null> {
  const history = await storage.readHistory(documentId);
  if (!history || history.versions.length === 0) return null;
  const latest = history.versions[history.versions.length - 1];
  try {
    const content = await new VersionManager(storage).reconstructVersion(
      documentId,
      latest.version,
    );
    return { version: latest.version, content };
  } catch {
    return null;
  }
}

/**
 * Reconstruct the document at its latest history version and return a
 * parsed node. Used when drift is detected: the engine's
 * `readDocument(verifyChecksum: true)` returns the nearest *keyframe*
 * (every 10 versions), which means a v=5 doc would render the v=1
 * body in the editor while the drift banner is shown. Reconstructing
 * from history.yaml gives the actual last-approved bytes.
 */
export async function loadLatestApprovedNode(
  nestId: string,
  documentId: string,
): Promise<ContextNode | null> {
  const { storage } = engineCache.get(nestId);
  const head = await loadChainHead(storage, documentId);
  if (!head) return null;
  return parseDocument(docPath(nestId, documentId), head.content, documentId);
}

/**
 * True when the live body hash matches the latest version's body in
 * history.yaml. Drift against the stored frontmatter checksum that
 * lands on a body we already wrote (PATCH/MCP save left a stale
 * checksum, or scanner raced between writeDocument and createVersion)
 * is not a real out-of-band edit — the content is recorded in history.
 *
 * A real external edit produces bytes no version reconstructs to and
 * still gets flagged.
 */
async function bodyMatchesLatestVersion(
  storage: NestStorage,
  documentId: string,
  liveBodyHash: string,
): Promise<boolean> {
  const head = await loadChainHead(storage, documentId);
  if (!head) return false;
  const headBodyHash = computeContentHash(getChecksumContent(head.content));
  return headBodyHash === liveBodyHash;
}

/**
 * Check a single document for drift and stage a suggestion if the live
 * bytes diverged from the last-approved checksum. Returns the staged
 * suggestion meta, or null when nothing drifted.
 */
export async function scanDocumentForDrift(
  nestId: string,
  documentId: string,
  actor: string = "system:scanner",
): Promise<SuggestionMeta | null> {
  const res = await scanDocumentForDriftInternal(nestId, documentId, actor);
  return res?.meta ?? null;
}

async function scanDocumentForDriftInternal(
  nestId: string,
  documentId: string,
  actor: string,
): Promise<{ meta: SuggestionMeta; created: boolean } | null> {
  const { storage } = engineCache.get(nestId);
  const node = await storage.readDocument(documentId).catch(() => null);
  if (!node) return null;

  const raw = await readRaw(nestId, documentId);
  if (raw == null) return null;

  const drift = detectDrift(raw, node.frontmatter.checksum);
  if (!drift.drifted) return null;

  // Skip staging when the live body already matches the latest version
  // in history — the bytes are ours (draft save / MCP update left a
  // stale checksum) and not an out-of-band edit. Without this the next
  // GET flips the doc to external_edit_pending right after a save.
  if (await bodyMatchesLatestVersion(storage, documentId, drift.actualHash)) {
    return null;
  }

  // Match the chain head the engine will read on approveSuggestion.
  // The engine calls `reconstructVersion(latest)`, which returns the live
  // post-publish bytes (frontmatter with status:published, version, and
  // checksum). Using `readLatestApprovedKeyframe` here returned the older
  // v=1 keyframe (pre-publish), so the suggestion's patch context was
  // built against draft frontmatter while the engine tried to apply it
  // against the v=2 reconstructed bytes — `applyPatch` returned false →
  // IntegrityError "Failed to apply suggestion ... to current approved
  // content".
  const approved = await loadChainHead(storage, documentId);
  if (!approved) return null;

  const existing = await listSuggestions(storage, documentId);
  const dup = existing.find((s) => s.proposed_hash === drift.actualHash);
  if (dup) return { meta: dup, created: false };

  const result = await stageSuggestion({
    storage,
    documentId,
    approvedRawContent: approved.content,
    proposedRawContent: raw,
    source: "out-of-band-edit",
    actor,
    docTier: "standard",
  });
  return { meta: result.meta, created: true };
}

/** Scan every document in a nest. Returns count of newly-staged suggestions. */
export async function scanNestForDrift(
  nestId: string,
  actor: string = "system:scanner",
): Promise<{ scanned: number; staged: number }> {
  const { storage } = engineCache.get(nestId);
  const docs = await storage.discoverDocuments();
  const results = await Promise.all(
    docs.map((doc) => scanDocumentForDriftInternal(nestId, doc.id, actor)),
  );
  const staged = results.filter((r) => r?.created).length;
  return { scanned: docs.length, staged };
}

/** Get the latest pending external edit for a document, if any.
 *
 * Stale suggestions whose proposed body has since been folded into
 * history (e.g. legacy entries staged before the latest-version guard
 * in scan) are filtered out so they no longer flip the doc to
 * external_edit_pending in the UI.
 */
export async function getPendingChange(
  nestId: string,
  documentId: string,
): Promise<PendingChange | null> {
  const { storage } = engineCache.get(nestId);
  const list = await listSuggestions(storage, documentId);
  for (let i = list.length - 1; i >= 0; i--) {
    const meta = list[i];
    if (await bodyMatchesLatestVersion(storage, documentId, meta.proposed_hash)) {
      continue;
    }
    return {
      suggestion_id: meta.suggestion_id,
      detected_at: meta.detected_at,
      source: meta.source,
      proposed_hash: meta.proposed_hash,
    };
  }
  return null;
}

/** List every pending external edit across all documents in a nest.
 *
 * Filters stale suggestions whose proposed body matches the document's
 * latest version — those are recorded history, not real out-of-band
 * edits, so showing them in the admin queue is misleading.
 */
export async function listNestExternalEdits(
  nestId: string,
): Promise<ExternalEditEntry[]> {
  const { storage } = engineCache.get(nestId);
  const docs = await storage.discoverDocuments();
  const lists = await Promise.all(
    docs.map(async (doc) => {
      const metas = await listSuggestions(storage, doc.id);
      const fresh: SuggestionMeta[] = [];
      for (const meta of metas) {
        if (await bodyMatchesLatestVersion(storage, doc.id, meta.proposed_hash)) {
          continue;
        }
        fresh.push(meta);
      }
      return fresh;
    }),
  );
  const entries: ExternalEditEntry[] = lists.flat().map((meta) => ({
    suggestion_id: meta.suggestion_id,
    nest_id: nestId,
    document_id: meta.document_id,
    source: meta.source,
    detected_at: meta.detected_at,
    actor: meta.actor,
    target_hash: meta.target_hash,
    proposed_hash: meta.proposed_hash,
    note: meta.note,
  }));
  return entries.sort((a, b) => b.detected_at.localeCompare(a.detected_at));
}

/** Read a single suggestion's full patch + meta for UI diff render. */
export async function getExternalEditDetail(
  nestId: string,
  documentId: string,
  suggestionId: string,
): Promise<ExternalEditEntry | null> {
  const { storage } = engineCache.get(nestId);
  const found = await readSuggestion(storage, documentId, suggestionId);
  if (!found) return null;
  return {
    suggestion_id: found.meta.suggestion_id,
    nest_id: nestId,
    document_id: found.meta.document_id,
    source: found.meta.source,
    detected_at: found.meta.detected_at,
    actor: found.meta.actor,
    target_hash: found.meta.target_hash,
    proposed_hash: found.meta.proposed_hash,
    note: found.meta.note,
    patch: found.patch,
  };
}

/** Approve a pending external edit — commits the patch as a new version. */
export async function approveExternalEdit(input: {
  nestId: string;
  documentId: string;
  suggestionId: string;
  actor: string;
  comment?: string;
}) {
  const { storage } = engineCache.get(input.nestId);
  let result;
  try {
    result = await approveSuggestion({
      storage,
      rbac: communityRbac,
      documentId: input.documentId,
      suggestionId: input.suggestionId,
      actor: input.actor,
      zone: "default",
      comment: input.comment,
    });
  } catch (err) {
    console.error(
      `[external-edit] approveSuggestion failed for ${input.nestId}/${input.documentId} suggestion=${input.suggestionId}:`,
      err,
    );
    throw err;
  }

  // Engine wrote the new version to disk + history.yaml but the
  // governance node_versions row was skipped — UI version history and
  // approved-version pin would drift behind disk. Mirror the engine
  // entry into SQLite so /versions, getCurrentVersion, and
  // setApprovedVersion all see the external edit.
  try {
    const node = await storage.readDocument(input.documentId);
    const versionNum = result.versionEntry.version;
    const tags = (node.frontmatter.tags || []) as string[];
    const { createVersion, setApprovedVersion } = await import(
      "./version-service.js"
    );
    createVersion({
      nestId: input.nestId,
      nodeId: input.documentId,
      version: versionNum,
      content: node.body || "",
      author: input.actor,
      status: "published",
      tags,
      changeNote: input.comment || "External edit approved",
    });
    setApprovedVersion(input.nestId, input.documentId, versionNum, input.actor);
  } catch (err) {
    console.error(
      `[external-edit] failed to mirror approved version into node_versions for ${input.nestId}/${input.documentId}:`,
      err,
    );
  }

  return result;
}

/**
 * Reject a pending external edit — archives the suggestion and reverts
 * the on-disk file back to the last-approved chain head.
 *
 * Without the revert step the file stays drifted, the next scanner tick
 * sees the same proposed_hash, and a fresh suggestion gets re-staged
 * with a new id — making the reject look like it "didn't take". Writing
 * the approved base back clears drift in one shot.
 */
export async function rejectExternalEdit(input: {
  nestId: string;
  documentId: string;
  suggestionId: string;
  actor: string;
  reason: string;
}) {
  const { storage } = engineCache.get(input.nestId);
  const result = await rejectSuggestion({
    storage,
    rbac: communityRbac,
    documentId: input.documentId,
    suggestionId: input.suggestionId,
    actor: input.actor,
    zone: "default",
    reason: input.reason,
  });

  // Revert disk to chain head so the drift scanner stops re-staging it.
  // loadChainHead uses the engine's reconstructVersion(latest) — same
  // base approveSuggestion would have rebuilt against.
  try {
    const approved = await loadChainHead(storage, input.documentId);
    if (approved) {
      await storage.writeDocument(input.documentId, approved.content);
    }
  } catch (err) {
    console.error(
      `[external-edit] revert-on-reject failed for ${input.nestId}/${input.documentId}:`,
      err,
    );
  }

  return result;
}

// ─── Background scanner ─────────────────────────────────────────────────

let scannerTimer: NodeJS.Timeout | null = null;

/** Iterate every nest on disk and scan for drift. */
async function scanAllNests(): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare("SELECT id FROM nests")
    .all() as Array<{ id: string }>;
  await Promise.all(
    rows.map(({ id }) =>
      scanNestForDrift(id).catch((err) =>
        console.error(`[external-edit] scan failed for nest ${id}:`, err),
      ),
    ),
  );
}

/** Start the periodic drift scanner. Idempotent — safe to call twice. */
export function startDriftScanner(intervalMs: number = 30_000): void {
  if (scannerTimer) return;
  scannerTimer = setInterval(() => {
    scanAllNests().catch((err) =>
      console.error("[external-edit] scanner tick failed:", err),
    );
  }, intervalMs);
  scannerTimer.unref?.();
}

/** Stop the periodic scanner (used by tests + graceful shutdown). */
export function stopDriftScanner(): void {
  if (scannerTimer) {
    clearInterval(scannerTimer);
    scannerTimer = null;
  }
}
