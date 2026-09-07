/**
 * External Edit Service — surfaces direct filesystem edits as pending
 * approvals (bridge-function-spec Story 3.1, hootie-inbox-spec §4).
 *
 * Wraps the engine's drift + suggestion primitives so the rest of the
 * community server can ignore PESWG hash-chain mechanics and just call
 * scan / list / approve / reject.
 */

import { readFile, readdir } from "fs/promises";
import { join, relative, sep } from "path";
import {
  detectDrift,
  stageSuggestion,
  ChainEventLog,
  approveSuggestion,
  rejectSuggestion,
  listSuggestions,
  readSuggestion,
  parseDocument,
  VersionManager,
  computeContentHash,
  getChecksumContent,
  type ContextNode,
  type HashChainEvent,
  type RbacHook,
  type SuggestionMeta,
  type PendingChange,
  type NestStorage,
} from "@promptowl/contextnest-engine";
import { engineCache } from "../nodes/engine.js";
import {
  setSuggestionFlag,
  markIndexStale,
  indexedNodeIds,
} from "../nodes/node-index.js";
import { getDb } from "../db/client.js";
import { resolveNestPath } from "../shared/paths.js";

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
  return join(resolveNestPath(nestId), `${documentId}.md`);
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
  const { storage } = await engineCache.get(nestId);
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
  const { storage } = await engineCache.get(nestId);
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

  // Same call, made where history can't answer it: a draft revision is not
  // appended to the chain, so an author's unreviewed working copy matches NO
  // version in history.yaml and would otherwise be staged as somebody else's
  // out-of-band edit. An unsealed row on top says the divergence is a draft in
  // progress — that is the app's own write, by definition.
  // Imported the way recordApproval imports its siblings — version-service and
  // this module reach for each other.
  const { hasUnsealedDraft } = await import("./version-service.js");
  if (await hasUnsealedDraft(nestId, documentId)) {
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
  if (dup) {
    // Already staged — but the flag may predate this table (or a rebuild that
    // never ran), so assert it rather than assume it.
    await setSuggestionFlag(nestId, documentId, true);
    return { meta: dup, created: false };
  }

  const result = await stageSuggestion({
    storage,
    documentId,
    approvedRawContent: approved.content,
    proposedRawContent: raw,
    source: "out-of-band-edit",
    actor,
    docTier: "standard",
  });
  // The listing reads this flag instead of walking the vault for
  // `_suggestions/` directories, so staging has to record it.
  await setSuggestionFlag(nestId, documentId, true);
  return { meta: result.meta, created: true };
}

/**
 * Re-derive one document's staged-suggestion flag from disk.
 *
 * After a verdict, because approving or rejecting ONE suggestion does not mean
 * the document has none left. One directory read for one document, on a write
 * path — not the whole-vault walk the listing used to pay on every request.
 */
async function refreshSuggestionFlag(
  nestId: string,
  storage: NestStorage,
  documentId: string,
): Promise<void> {
  try {
    const remaining = await listSuggestions(storage, documentId);
    await setSuggestionFlag(nestId, documentId, remaining.length > 0);
  } catch (err) {
    console.error("[external-edit] flag refresh failed", nestId, documentId, err);
  }
}

/** Scan every document in a nest. Returns count of newly-staged suggestions. */
export async function scanNestForDrift(
  nestId: string,
  actor: string = "system:scanner",
): Promise<{ scanned: number; staged: number }> {
  const { storage, dropDiscoveryCache } = await engineCache.get(nestId);
  // Edits made outside this process are the whole point of the scan, so it
  // reads disk directly rather than the cached document set — which by
  // definition cannot contain a write this server never made.
  //
  // The memory-only invalidator, NOT invalidateDiscovery. This scan runs on a
  // timer over EVERY nest (DRIFT_SCAN_INTERVAL_MS, 30s by default), so marking
  // the DB index stale here left every nest permanently stale — and every
  // listing then paid a full rebuild crawl, which is the exact cost the index
  // exists to remove. A scan that finds nothing has proven the mirror right,
  // not wrong; it is only what the scan FINDS that can invalidate it.
  dropDiscoveryCache();
  const docs = await storage.discoverDocuments();
  const results = await Promise.all(
    docs.map((doc) => scanDocumentForDriftInternal(nestId, doc.id, actor)),
  );
  const staged = results.filter((r) => r?.created).length;

  // Two ways this scan can prove the mirror wrong, both cheap to check now
  // that the vault has just been read:
  //   - it staged an edit, so a document's bytes (and likely its frontmatter)
  //     moved out of band;
  //   - the document SET differs, i.e. a file was added or removed outside the
  //     app — which drift detection alone never reports, since it only visits
  //     documents discovery already found.
  // `includeRetired` to match what the index stores; it is a cache hit on the
  // crawl above, not a second walk.
  const onDisk = await storage.discoverDocuments({ includeRetired: true });
  const indexed = await indexedNodeIds(nestId);
  const membershipMoved =
    indexed.size !== onDisk.length || onDisk.some((d) => !indexed.has(d.id));
  if (staged > 0 || membershipMoved) await markIndexStale(nestId);

  return { scanned: docs.length, staged };
}

/**
 * Document ids with at least one staged suggestion, from ONE directory walk
 * instead of a glob per document — a listing was opening a `_suggestions`
 * directory for all 400 nodes of a nest that usually has zero drift.
 *
 * Layout is `{docDir}/_suggestions/{docName}/{id}.meta.yaml` (engine
 * NestStorage.suggestionDir); `_archive` holds resolved ones, not staged.
 */
export async function documentsWithSuggestions(
  nestId: string,
): Promise<Set<string>> {
  const root = resolveNestPath(nestId);
  const ids = new Set<string>();
  let entries;
  try {
    entries = await readdir(root, { recursive: true, withFileTypes: true });
  } catch (err: any) {
    // A missing folder genuinely means nothing is staged. Anything else
    // (permissions, descriptor exhaustion) is NOT that, and this one walk
    // covers every document — so a swallowed failure drops pending-edit
    // detection for the WHOLE nest, where the per-node reads it replaced
    // lost one document each. Still degrade rather than fail the listing:
    // drift badges are advisory, and a transient fs error should not 500 a
    // nest. Logged so the difference is visible instead of silent.
    if (err?.code !== "ENOENT") {
      console.error("[external-edit] suggestion scan failed", nestId, err);
    }
    return ids;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".meta.yaml")) continue;
    const dir = (e as any).parentPath ?? (e as any).path ?? root;
    const rel = relative(root, dir).split(sep).join("/");
    const segs = rel.split("/");
    const marker = segs.lastIndexOf("_suggestions");
    // The doc name is the segment right after `_suggestions`; anything deeper
    // is the archive.
    if (marker === -1 || segs.length !== marker + 2) continue;
    ids.add([...segs.slice(0, marker), segs[marker + 1]].filter(Boolean).join("/"));
  }
  return ids;
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
  const { storage } = await engineCache.get(nestId);
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
  const { storage } = await engineCache.get(nestId);
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
  const { storage } = await engineCache.get(nestId);
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

/** A verdict on an external edit, as document history renders it. */
export interface ExternalEditVerdict {
  suggestion_id: string;
  status: "approved" | "rejected";
  /** Who approved or rejected it. */
  actor: string;
  /** ISO-8601, from the engine's chain event. */
  at: string;
  /** Rejection reason, or the approver's comment when they left one. */
  note?: string;
  source?: string;
}

/**
 * Persist a governance verdict in the engine's append-only chain-event log
 * (`.versions/chain_events.yaml`). The engine builds these events and returns
 * them, but writes none — so every verdict on an external edit was lost the
 * moment the route responded. Best-effort: the edit is already approved or
 * rejected on disk, so a failed audit write must not fail the request; the
 * caller is told it did not land rather than being shown a clean success.
 */
async function recordVerdict(
  nestId: string,
  event: HashChainEvent,
): Promise<boolean> {
  try {
    const { storage } = await engineCache.get(nestId);
    await new ChainEventLog(storage).append(event);
    return true;
  } catch (err) {
    console.error(
      `[external-edit] failed to record verdict ${event.event_id} for nest ${nestId}:`,
      err,
    );
    return false;
  }
}

/**
 * Every recorded verdict on a document's external edits, oldest first.
 *
 * Read straight off the engine's chain-event log — a rejection changes no
 * content, so it earns no version, and this is the audit trail rather than
 * `node_versions`. `suggestion_id` in the metadata is what marks an event as a
 * verdict on a staged edit (a Czar direct edit shares one of the event types
 * but carries no suggestion); `rejection_reason` is what separates the two
 * verdicts, since the engine records a standard-tier rejection as an "altered
 * to no change" event rather than a rejection type of its own.
 */
export async function listExternalEditVerdicts(
  nestId: string,
  documentId: string,
): Promise<ExternalEditVerdict[]> {
  try {
    const { storage } = await engineCache.get(nestId);
    const events = await new ChainEventLog(storage).readByDocument(documentId);
    return events.flatMap((e) => {
      const meta = (e.action_metadata || {}) as Record<string, unknown>;
      if (typeof meta.suggestion_id !== "string") return [];
      const reason = meta.rejection_reason;
      const comment = meta.approval_comment;
      return [
        {
          suggestion_id: meta.suggestion_id,
          status: (typeof reason === "string" ? "rejected" : "approved") as
            | "approved"
            | "rejected",
          actor: e.actor,
          at: e.timestamp,
          note:
            typeof reason === "string"
              ? reason
              : typeof comment === "string"
                ? comment
                : undefined,
          source: typeof meta.source === "string" ? meta.source : undefined,
        },
      ];
    });
  } catch (err) {
    console.error(
      `[external-edit] failed to read verdicts for ${nestId}/${documentId}:`,
      err,
    );
    return [];
  }
}

/**
 * Mirror an engine version into the governance `node_versions` row that the
 * UI's document history reads. Without it a verdict on an external edit is
 * invisible: history, the approved-version pin and getCurrentVersion all read
 * SQLite, not history.yaml.
 */
async function mirrorVersion(input: {
  nestId: string;
  documentId: string;
  version: number;
  actor: string;
  note: string;
}) {
  const { storage } = await engineCache.get(input.nestId);
  const node = await storage.readDocument(input.documentId);
  const { upsertVersion, setApprovedVersion } = await import(
    "./version-service.js"
  );
  // upsert, not insert: the engine commits a version here, but a governance
  // row can already exist at that number (an imported nest, a mirror that
  // failed and is being retried). Insert-only turned that into a UNIQUE
  // violation that silently dropped the approval from history.
  await upsertVersion({
    nestId: input.nestId,
    nodeId: input.documentId,
    version: input.version,
    content: node.body || "",
    author: input.actor,
    status: "published",
    tags: (node.frontmatter.tags || []) as string[],
    changeNote: input.note,
  });
  await setApprovedVersion(
    input.nestId,
    input.documentId,
    input.version,
    input.actor,
  );
}

/** Approve a pending external edit — commits the patch as a new version. */
export async function approveExternalEdit(input: {
  nestId: string;
  documentId: string;
  suggestionId: string;
  actor: string;
  comment?: string;
}) {
  const { storage } = await engineCache.get(input.nestId);
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
  // setApprovedVersion all see the external edit. Best-effort: the engine
  // already committed, so a failed mirror must not fail the approval.
  try {
    await mirrorVersion({
      nestId: input.nestId,
      documentId: input.documentId,
      version: result.versionEntry.version,
      actor: input.actor,
      note: input.comment
        ? `External edit approved: ${input.comment}`
        : "External edit approved",
    });
  } catch (err) {
    console.error(
      `[external-edit] failed to mirror approved version into node_versions for ${input.nestId}/${input.documentId}:`,
      err,
    );
  }

  // Same verdict record as a rejection, and reported the same way — an
  // approval whose audit entry did not land must not read as a clean success
  // either, even though the content change itself is already committed.
  const historyRecorded = await recordVerdict(input.nestId, result.chainEvent);

  await refreshSuggestionFlag(input.nestId, storage, input.documentId);
  return { ...result, historyRecorded };
}

/**
 * Reject a pending external edit — archives the suggestion, records the
 * verdict, and reverts the on-disk file back to the last-approved chain head.
 *
 * Without the revert step the file stays drifted, the next scanner tick
 * sees the same proposed_hash, and a fresh suggestion gets re-staged
 * with a new id — making the reject look like it "didn't take". Writing
 * the approved base back clears drift in one shot.
 *
 * A rejection changes no content, so it earns no version: the verdict goes to
 * the engine's chain-event log, and the rejected bytes stay where the engine
 * already keeps them permanently (`_archive/rejected/`).
 *
 * `historyRecorded` reports whether the verdict landed, so a caller is never
 * told the audit write succeeded when it did not.
 */
export async function rejectExternalEdit(input: {
  nestId: string;
  documentId: string;
  suggestionId: string;
  actor: string;
  reason: string;
}) {
  const { storage } = await engineCache.get(input.nestId);
  const result = await rejectSuggestion({
    storage,
    rbac: communityRbac,
    documentId: input.documentId,
    suggestionId: input.suggestionId,
    actor: input.actor,
    zone: "default",
    reason: input.reason,
  });

  // The verdict itself — who rejected, when, and why — is what the engine
  // hands back and then forgets: rejectSuggestion builds the chain event but
  // never writes it, so dropping it here is what left rejections with no
  // audit trail. Appending costs no version and no new storage: the log is
  // the engine's own .versions/chain_events.yaml.
  const historyRecorded = await recordVerdict(input.nestId, result.chainEvent);

  // Revert disk to chain head so the drift scanner stops re-staging it.
  // loadChainHead uses the engine's reconstructVersion(latest) — same
  // base approveSuggestion would have rebuilt against. No publish: those
  // reconstructed bytes carry the checksum they were published with, so the
  // restored file already matches and drift clears without a version bump.
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

  await refreshSuggestionFlag(input.nestId, storage, input.documentId);
  return { ...result, historyRecorded };
}

// ─── Background scanner ─────────────────────────────────────────────────

let scannerTimer: NodeJS.Timeout | null = null;

/** Iterate every nest on disk and scan for drift. */
async function scanAllNests(): Promise<void> {
  const db = getDb();
  const rows = await db.all("SELECT id FROM nests") as Array<{ id: string }>;
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
