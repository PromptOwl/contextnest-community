/**
 * Push Confirmation Gate — service layer.
 *
 * When a nest has require_push_confirmation ON, an agent write — the MCP
 * context_create tool, POST /nests/:id/nodes from an API key, or a bulk POST
 * /nests/:id/publish — is HELD as a pending_pushes row instead of applying. It
 * applies only after a reviewer confirms it in the web UI (or the submitting
 * key is whitelisted). A person working in this app is never held. This module
 * owns:
 *   - the pending-push lifecycle (create / list / get / confirm / reject / expire)
 *   - the per-API-key allowlist (check / add / remove / list)
 *   - the confirm-authority check (reviewer/owner/admin only; a submitter may
 *     reject its own push but never confirm it)
 *
 * Confirm reuses the REAL apply path (applyPublish) so a held push lands exactly
 * as an immediate one would.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { ValidationError } from "../shared/errors.js";
import { resolveNestAccess } from "../shared/access.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { nestRequiresPushConfirmation } from "./service.js";
import { engineCache } from "../nodes/engine.js";
import { derivedNodeId } from "../nodes/service.js";
import { assertPushConforms } from "../structure/writes.js";

/** The first name a title with no a-z letters or digits gets (createNode's `document-N`). */
const GENERATED_NAME = "document-1";
import { notifyPendingPush } from "../governance/notify-service.js";
import {
  applyPublish,
  buildManifest,
  countPublishDocs,
  publishableDocs,
  type PublishPayload,
  type PushManifestEntry,
} from "../nodes/publish-apply.js";

export type PendingPushStatus = "pending" | "applied" | "rejected" | "expired";

/** '' key_id means "any of that user's keys" — see migration 040. */
const ALL_KEYS = "";
/** key_id for keyless agent writes (PromptOwl service ticket, signed-in MCP):
 *  whitelists those alone, never the user's API keys. Real key ids are UUIDs,
 *  so this can't collide with one. */
const KEYLESS = "keyless";

export interface PendingPushRow {
  id: string;
  nest_id: string;
  submitter_user_id: string;
  submitter_key_id: string | null;
  submitter_label: string | null;
  submitter_email: string | null;
  doc_count: number;
  manifest_json: string;
  payload_blob: string;
  context_md: string | null;
  status: PendingPushStatus;
  created_at: string;
  decided_at: string | null;
  decided_by_user_id: string | null;
  applied_node_count: number | null;
  expires_at: string;
}

/** The shape the CLI polls / the modal renders. */
export interface PendingPushView {
  id: string;
  status: PendingPushStatus;
  nest_name: string;
  doc_count: number;
  manifest: PushManifestEntry[];
  submitter_label: string | null;
  submitter_email: string | null;
  submitter_user_id: string;
  created_at: string;
  expires_at: string;
  decided_by?: string;
  decided_at?: string;
  applied_node_count?: number;
  /** Single-push GET only: the context.md the push would write. */
  context_md?: string | null;
}

async function nestName(nestId: string): Promise<string> {
  const row = (await getDb().get("SELECT name FROM nests WHERE id = ?", [
    nestId,
  ])) as { name?: string } | undefined;
  return row?.name ?? nestId;
}

function toView(row: PendingPushRow, name: string): PendingPushView {
  let manifest: PushManifestEntry[] = [];
  try {
    manifest = JSON.parse(row.manifest_json) as PushManifestEntry[];
  } catch {
    manifest = [];
  }
  return {
    id: row.id,
    status: row.status,
    nest_name: name,
    doc_count: row.doc_count,
    manifest,
    submitter_label: row.submitter_label,
    submitter_email: row.submitter_email,
    submitter_user_id: row.submitter_user_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
    decided_by: row.decided_by_user_id ?? undefined,
    decided_at: row.decided_at ?? undefined,
    applied_node_count: row.applied_node_count ?? undefined,
  };
}

// ── Allowlist ──────────────────────────────────────────────────────────────

/**
 * True when this exact credential is whitelisted for automated pushes: a row
 * matching (nest, user) with key_id = this key OR key_id = '' (all the user's
 * keys). Never matches on nest alone.
 */
export async function isPushAllowlisted(
  nestId: string,
  userId: string,
  keyId: string | null,
): Promise<boolean> {
  const row = (await getDb().get(
    `SELECT 1 FROM push_allowlist
      WHERE nest_id = ? AND user_id = ?
        AND (key_id = ? OR key_id = ?)
      LIMIT 1`,
    [nestId, userId, ALL_KEYS, keyId ?? KEYLESS],
  )) as { 1: number } | undefined;
  return !!row;
}

export async function addToPushAllowlist(params: {
  nestId: string;
  userId: string;
  keyId: string | null;
  createdBy: string;
}): Promise<void> {
  const { nestId, userId, keyId, createdBy } = params;
  await getDb().run(
    `INSERT INTO push_allowlist (nest_id, user_id, key_id, created_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (nest_id, user_id, key_id) DO NOTHING`,
    [nestId, userId, keyId ?? ALL_KEYS, createdBy, new Date().toISOString()],
  );
}

export async function listPushAllowlist(nestId: string): Promise<
  Array<{
    user_id: string;
    key_id: string | null;
    user_email: string | null;
    key_label: string | null;
    created_by_user_id: string;
    created_at: string;
  }>
> {
  // Joined here rather than resolved row-by-row in the UI: a whitelist entry
  // is unreadable as a pair of opaque ids, and "who can push, with which key"
  // is the whole point of the screen.
  const rows = (await getDb().all(
    `SELECT a.user_id, a.key_id, a.created_by_user_id, a.created_at,
            u.email AS user_email, k.label AS key_label
       FROM push_allowlist a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN api_keys k ON k.id = a.key_id
      WHERE a.nest_id = ? ORDER BY a.created_at DESC`,
    [nestId],
  )) as Array<{
    user_id: string;
    key_id: string;
    user_email: string | null;
    key_label: string | null;
    created_by_user_id: string;
    created_at: string;
  }>;
  // Surface the '' sentinel as null ("all keys") at the API boundary.
  return rows.map((r) => ({
    ...r,
    key_id: r.key_id === ALL_KEYS ? null : r.key_id,
    key_label: r.key_id === KEYLESS ? "PromptOwl / signed-in session" : r.key_label,
  }));
}

export async function removeFromPushAllowlist(params: {
  nestId: string;
  userId: string;
  keyId: string | null;
}): Promise<boolean> {
  const { nestId, userId, keyId } = params;
  const res = await getDb().run(
    "DELETE FROM push_allowlist WHERE nest_id = ? AND user_id = ? AND key_id = ?",
    [nestId, userId, keyId ?? ALL_KEYS],
  );
  return res.changes > 0;
}

// ── Pending pushes ─────────────────────────────────────────────────────────

/** Stage a held push. Rejects payloads over MAX_PENDING_PUSH_BYTES. */
export async function createPendingPush(params: {
  nestId: string;
  submitterUserId: string;
  submitterKeyId: string | null;
  submitterLabel: string | null;
  submitterEmail: string | null;
  payload: PublishPayload;
}): Promise<PendingPushView> {
  const { nestId, submitterUserId, submitterKeyId, submitterLabel, submitterEmail, payload } =
    params;

  const payloadBlob = JSON.stringify(payload);
  if (Buffer.byteLength(payloadBlob, "utf8") > config.MAX_PENDING_PUSH_BYTES) {
    throw new ValidationError(
      `Push payload exceeds the ${config.MAX_PENDING_PUSH_BYTES}-byte limit for a held push (MAX_PENDING_PUSH_BYTES).`,
    );
  }

  const { storage } = await engineCache.get(nestId);
  await assertPushConforms(
    storage,
    publishableDocs(payload).map((d) => ({
      title: d.title,
      id: derivedNodeId(d.title, d.folder) ?? derivedNodeId(GENERATED_NAME, d.folder)!,
      type: d.type,
      body: d.content,
      status: d.status,
    })),
  );

  const id = uuid();
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + config.PENDING_PUSH_TTL_MS).toISOString();
  const manifest = buildManifest(payload);
  const docCount = countPublishDocs(payload);

  await getDb().run(
    `INSERT INTO pending_pushes
       (id, nest_id, submitter_user_id, submitter_key_id, submitter_label,
        submitter_email, doc_count, manifest_json, payload_blob, context_md,
        status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      id,
      nestId,
      submitterUserId,
      submitterKeyId,
      submitterLabel,
      submitterEmail,
      docCount,
      JSON.stringify(manifest),
      payloadBlob,
      payload.context_md ?? null,
      createdAt,
      expiresAt,
    ],
  );

  const name = await nestName(nestId);
  const row = (await getDb().get("SELECT * FROM pending_pushes WHERE id = ?", [
    id,
  ])) as PendingPushRow;
  return toView(row, name);
}

/**
 * The one gate check every agent write goes through: `POST /publish`, the REST
 * single create, and the MCP `context_create` tool. Returns the held record
 * when this credential's write must wait for a reviewer, or null when it may
 * apply immediately (gate off, or this key is whitelisted).
 *
 * Callers decide whether they are an agent surface before calling — a person
 * clicking New Document in the web UI (cookie session, no API key) is never
 * held; the gate exists for writes nobody watched being made.
 */
export async function holdWriteIfGated(params: {
  nestId: string;
  userId: string;
  keyId: string | null;
  keyLabel: string | null;
  userEmail: string;
  payload: PublishPayload;
}): Promise<PendingPushView | null> {
  const { nestId, userId, keyId, keyLabel, userEmail, payload } = params;

  if (!(await nestRequiresPushConfirmation(nestId))) return null;
  if (await isPushAllowlisted(nestId, userId, keyId)) return null;

  const pending = await createPendingPush({
    nestId,
    submitterUserId: userId,
    submitterKeyId: keyId,
    submitterLabel: keyLabel ?? userEmail,
    submitterEmail: userEmail,
    payload,
  });

  // Best-effort: a notify failure must never fail the hold.
  try {
    await notifyPendingPush({
      nestId,
      pendingId: pending.id,
      submitterEmail: userEmail,
      submitterLabel: keyLabel ?? userEmail,
      docCount: pending.doc_count,
    });
  } catch (err) {
    console.error("[push] pending-push notify failed", nestId, err);
  }

  return pending;
}

/** The 202 body every held write returns, whatever surface it arrived on. */
export function heldWriteResponse(nestId: string, pending: PendingPushView) {
  return {
    status: "pending_confirmation" as const,
    pending_id: pending.id,
    confirm_url: `/nests/${nestId}/pending-pushes/${pending.id}/confirm`,
    poll_url: `/nests/${nestId}/pending-pushes/${pending.id}`,
    message:
      `This nest holds agent writes for review. Your write of ${pending.doc_count} document(s) is waiting — ` +
      `it lands once a reviewer confirms it in ${pending.nest_name}.`,
    expires_at: pending.expires_at,
  };
}

/**
 * Lazily flip any still-'pending' rows whose TTL has passed to 'expired'. Runs
 * at list/get time; a periodic sweep can call it too. Returns rows expired.
 */
export async function expirePendingPushes(nestId?: string): Promise<number> {
  const now = new Date().toISOString();
  const res = nestId
    ? await getDb().run(
        "UPDATE pending_pushes SET status = 'expired' WHERE status = 'pending' AND expires_at <= ? AND nest_id = ?",
        [now, nestId],
      )
    : await getDb().run(
        "UPDATE pending_pushes SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
        [now],
      );
  return res.changes;
}

export async function listPendingPushes(
  nestId: string,
  status?: PendingPushStatus,
): Promise<PendingPushView[]> {
  await expirePendingPushes(nestId);
  const rows = (await getDb().all(
    status
      ? "SELECT * FROM pending_pushes WHERE nest_id = ? AND status = ? ORDER BY created_at DESC"
      : "SELECT * FROM pending_pushes WHERE nest_id = ? ORDER BY created_at DESC",
    status ? [nestId, status] : [nestId],
  )) as PendingPushRow[];
  const name = await nestName(nestId);
  return rows.map((r) => toView(r, name));
}

/** Raw row (for the confirm/reject transactions). null if wrong nest/id. */
export async function getPendingPushRow(
  nestId: string,
  id: string,
): Promise<PendingPushRow | null> {
  await expirePendingPushes(nestId);
  const row = (await getDb().get(
    "SELECT * FROM pending_pushes WHERE id = ? AND nest_id = ?",
    [id, nestId],
  )) as PendingPushRow | undefined;
  return row ?? null;
}

export async function getPendingPush(
  nestId: string,
  id: string,
): Promise<PendingPushView | null> {
  const row = await getPendingPushRow(nestId, id);
  if (!row) return null;
  const view = toView(row, await nestName(nestId));
  // The single view carries what would be written, so a reviewer can read it
  // before confirming. manifest_json was built from publishableDocs too, in order.
  let docs: Array<{ content?: string }> = [];
  try {
    docs = publishableDocs(JSON.parse(row.payload_blob) as PublishPayload);
  } catch {
    docs = [];
  }
  return {
    ...view,
    manifest: view.manifest.map((m, i) => ({ ...m, content: docs[i]?.content })),
    context_md: row.context_md,
  };
}

/**
 * Confirm a held push: transactionally claim the row (UPDATE … WHERE
 * status='pending' — .changes===0 means someone else decided it, or it
 * expired), then apply the stored payload through the real apply path. Optional
 * alwaysAllow whitelists the submitter's exact key for future pushes.
 */
export async function confirmPendingPush(
  nestId: string,
  id: string,
  deciderUserId: string,
  opts: { alwaysAllow?: boolean } = {},
): Promise<
  | { ok: true; view: PendingPushView }
  | { ok: false; reason: "not_found" | "not_pending" }
> {
  const db = getDb();
  const row = await getPendingPushRow(nestId, id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "pending") return { ok: false, reason: "not_pending" };

  // Atomic claim: only the caller who flips pending→applied gets to apply.
  const decidedAt = new Date().toISOString();
  const claim = await db.run(
    "UPDATE pending_pushes SET status = 'applied', decided_at = ?, decided_by_user_id = ? WHERE id = ? AND nest_id = ? AND status = 'pending'",
    [decidedAt, deciderUserId, id, nestId],
  );
  if (claim.changes === 0) return { ok: false, reason: "not_pending" };

  let payload: PublishPayload = {};
  try {
    payload = JSON.parse(row.payload_blob) as PublishPayload;
  } catch {
    payload = {};
  }

  // The documents belong to whoever pushed them, not to the reviewer who let
  // them through: attribute the writes to the submitter.
  const authorEmail =
    row.submitter_email ?? (await resolveCallerEmail(row.submitter_user_id));

  let result;
  try {
    result = await applyPublish(nestId, payload, authorEmail);
  } catch (err) {
    // The claim above already flipped the row to 'applied'. If the apply then
    // throws (busy vault, disk, unusable payload) nothing landed, so hand the
    // row back to 'pending' — otherwise it is permanently "applied" with no
    // documents and every retry gets a 409.
    await db.run(
      "UPDATE pending_pushes SET status = 'pending', decided_at = NULL, decided_by_user_id = NULL WHERE id = ? AND nest_id = ? AND status = 'applied'",
      [id, nestId],
    );
    throw err;
  }

  await db.run(
    "UPDATE pending_pushes SET applied_node_count = ? WHERE id = ?",
    [result.published, id],
  );

  // A keyless push whitelists KEYLESS, never '' — that covers every key of the user.
  if (opts.alwaysAllow) {
    await addToPushAllowlist({
      nestId,
      userId: row.submitter_user_id,
      keyId: row.submitter_key_id ?? KEYLESS,
      createdBy: deciderUserId,
    });
  }

  const view = await getPendingPush(nestId, id);
  return { ok: true, view: view! };
}

/** Reject a held push. Never applies. Idempotency-guarded like confirm. */
export async function rejectPendingPush(
  nestId: string,
  id: string,
  deciderUserId: string,
): Promise<
  | { ok: true; view: PendingPushView }
  | { ok: false; reason: "not_found" | "not_pending" }
> {
  const db = getDb();
  const row = await getPendingPushRow(nestId, id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "pending") return { ok: false, reason: "not_pending" };

  const decidedAt = new Date().toISOString();
  const claim = await db.run(
    "UPDATE pending_pushes SET status = 'rejected', decided_at = ?, decided_by_user_id = ? WHERE id = ? AND nest_id = ? AND status = 'pending'",
    [decidedAt, deciderUserId, id, nestId],
  );
  if (claim.changes === 0) return { ok: false, reason: "not_pending" };

  const view = await getPendingPush(nestId, id);
  return { ok: true, view: view! };
}

// ── Authority ──────────────────────────────────────────────────────────────

/**
 * Who may CONFIRM a held push: a reviewer/owner/admin of the nest, and nobody
 * else. The submitter is deliberately excluded — letting it confirm its own
 * push turns the gate into one extra HTTP call with the same key (and, with
 * always_allow, whitelists the very credential being gated). Confirmation is
 * the human-in-the-loop; it cannot be the machine that pushed.
 */
export async function canConfirmPush(params: {
  nestId: string;
  userId: string;
  userEmail: string;
}): Promise<boolean> {
  const { nestId, userId, userEmail } = params;
  return isNestReviewer(nestId, userId, userEmail);
}

/**
 * Who may REJECT a held push: a reviewer, or the submitter cancelling its own.
 * Rejecting never writes, so a submitter withdrawing a push it regrets is safe
 * where confirming is not.
 */
export async function canRejectPush(params: {
  nestId: string;
  userId: string;
  userEmail: string;
  submitterUserId?: string;
}): Promise<boolean> {
  const { nestId, userId, userEmail, submitterUserId } = params;
  if (submitterUserId && submitterUserId === userId) return true;
  return isNestReviewer(nestId, userId, userEmail);
}

/** owner/admin of the nest, or a reviewer steward. */
export async function isNestReviewer(
  nestId: string,
  userId: string,
  userEmail: string,
): Promise<boolean> {
  const access = await resolveNestAccess(nestId, userId);
  if (access.permission === "owner" || access.permission === "admin") return true;
  const steward = (await getDb().get(
    `SELECT 1 FROM stewards
      WHERE nest_id = ? AND role = 'reviewer' AND is_active = 1
        AND LOWER(user_email) = LOWER(?)
      LIMIT 1`,
    [nestId, userEmail],
  )) as { 1: number } | undefined;
  return !!steward;
}
