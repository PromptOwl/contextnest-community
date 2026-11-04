/**
 * Cards (PRD §4.12, AC-CRD-*): build the surface-neutral CardModel for a
 * proposal from the database, post it once into its own conversation and
 * thread, and update it in place with the outcome.
 *
 *  - A card goes ONLY to its binding's conversation (AC-CRD-01): the binding
 *    is read from the proposal row, never from the caller.
 *  - Posting is claimed (card_ref NULL → 'posting') and committed with a
 *    compare-and-set on the state, so `posted` never overwrites `withdrawn`
 *    or `expired`; a card that lost that race is updated to its outcome.
 *  - Nest-sourced strings (the conflict's "On record") ride only when the
 *    binding's surface_ok holds; model text follows S2a's H1 rule
 *    (blockkit.ts shownText).
 *  - Outcome updates render BEFORE titles are purged, and only once.
 */
import { getDb } from "../../db/client.js";
import { config } from "../../config.js";
import type { BindingRef, CardRef, ProposalView } from "../contract.js";
import type { CardItem, CardModel, CardOutcome } from "../core/card-model.js";
import { getConnector } from "../registry.js";
import { getBindingRow, type BindingRow } from "./binding-service.js";
import { getInstall, installRef, type InstallRow } from "./install-store.js";
import { activeLink } from "./identity-service.js";
import { getSettings } from "./settings-service.js";

export interface ProposalRow {
  id: string;
  window_id: string;
  binding_id: string;
  nest_id: string;
  card_kind: "single" | "merged" | "conflict" | "agent";
  state: "queued" | "held" | "posted" | "decided" | "expired" | "withdrawn";
  named_reviewer_user_id: string | null;
  forced: number;
  card_ref: string | null;
  queued_release_at: string | null;
  posted_at: string | null;
  expires_at: string;
  queue_reason: string | null;
  hold_reason: string | null;
  confidence: number | null;
  outcome_rendered: string | null;
  window_guard: string | null;
  message_count: number;
  first_ts: string | null;
  last_ts: string | null;
  requested_by_surface_user_id: string | null;
  created_at: string;
}

export interface ItemRow {
  id: string;
  proposal_id: string;
  nest_id: string;
  review_id: string | null;
  node_id: string | null;
  item_kind: string;
  op: string;
  target_folder: string;
  target_node_id: string | null;
  title: string | null;
  summary: string | null;
  why: string | null;
  on_record: string | null;
  confidence: number | null;
  state: string;
  decided_by_user_id: string | null;
  version: number | null;
  reason: string | null;
  edited: number;
  previously_held_on: string | null;
  created_at: string;
}

const nowIso = () => new Date().toISOString();

export async function getProposal(id: string): Promise<ProposalRow | null> {
  return ((await getDb().get("SELECT * FROM surface_proposals WHERE id = ?", [id])) as ProposalRow | undefined) ?? null;
}

export async function getItems(proposalId: string): Promise<ItemRow[]> {
  return (await getDb().all("SELECT * FROM surface_proposal_items WHERE proposal_id = ? ORDER BY created_at, id", [proposalId])) as ItemRow[];
}

export function draftUrl(itemId: string): string {
  return `${(config.PUBLIC_BASE_URL || "").replace(/\/+$/, "")}/surfaces/drafts/${itemId}`;
}

export function bindingRef(b: BindingRow): BindingRef {
  return { id: b.id, install_id: b.install_id, conversation_id: b.conversation_id, nest_id: b.nest_id };
}

function tsLabel(ts: string | null, tz: string): string | null {
  if (!ts) return null;
  const ms = Number(String(ts).split(".")[0]) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz, timeZoneName: "short" });
  } catch {
    return new Date(ms).toISOString().slice(11, 16) + " UTC";
  }
}

export function dateLabel(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
  } catch {
    return iso.slice(0, 10);
  }
}

export async function nestName(nestId: string): Promise<string> {
  const r = (await getDb().get("SELECT name FROM nests WHERE id = ?", [nestId])) as { name?: string } | undefined;
  return r?.name ?? "the nest";
}

/** A Community user's Slack mention in this install ("<@U…>"), or null. */
export async function mentionFor(installId: string, communityUserId: string | null): Promise<string | null> {
  if (!communityUserId) return null;
  const r = (await getDb().get(
    "SELECT surface_user_id FROM surface_identity_links WHERE install_id = ? AND community_user_id = ? AND status = 'active'",
    [installId, communityUserId],
  )) as { surface_user_id: string } | undefined;
  return r && /^[A-Z0-9_]+$/.test(r.surface_user_id) ? `<@${r.surface_user_id}>` : null;
}

export async function buildCardModel(p: ProposalRow, binding: BindingRow, items: ItemRow[], outcome: CardOutcome | null = null): Promise<CardModel> {
  const settings = await getSettings();
  const tz = settings.timezone || "UTC";
  const nest = await nestName(p.nest_id);
  const recordTitles = new Map<string, string>();
  for (const it of items) {
    if (it.op === "edit" && it.target_node_id) {
      const t = (await getDb().get("SELECT title FROM node_index WHERE nest_id = ? AND node_id = ?", [p.nest_id, it.target_node_id]).catch(() => undefined)) as
        | { title?: string }
        | undefined;
      recordTitles.set(it.id, t?.title ?? it.target_node_id.replace(/^nodes\//, ""));
    }
  }
  const cardItems: CardItem[] = items
    .filter((i) => outcome || i.state === "pending")
    .map((i) => ({
      id: i.id,
      kind: i.item_kind,
      op: i.op,
      title: i.title ?? "",
      summary: i.summary ?? "",
      why: i.why,
      folder: i.target_folder,
      node_id: i.node_id,
      draft_url: draftUrl(i.id),
      on_record: binding.surface_ok ? i.on_record : null,
      record_title: binding.surface_ok ? (recordTitles.get(i.id) ?? null) : null,
    }));
  const isConflict = cardItems.length === 1 && cardItems[0].op === "edit";
  const held = items.find((i) => i.previously_held_on)?.previously_held_on ?? null;
  const canEdit = await reviewerCanEdit(p.nest_id, p.named_reviewer_user_id, cardItems);
  return {
    can_edit: canEdit,
    proposal_id: p.id,
    kind: p.card_kind === "agent" ? "agent" : isConflict ? "conflict" : cardItems.length > 1 ? "merged" : "single",
    forced: !!p.forced,
    nest_name: nest,
    items: cardItems,
    message_count: Number(p.message_count || 0),
    from_label: tsLabel(p.first_ts, tz),
    to_label: tsLabel(p.last_ts, tz),
    reviewer: await mentionFor(binding.install_id, p.named_reviewer_user_id),
    expires_label: dateLabel(p.expires_at, tz),
    surface_ok: !!binding.surface_ok,
    dm: binding.conversation_kind === "dm" ? { first: !(binding as BindingRow & { dm_intro_card_at?: string | null }).dm_intro_card_at } : null,
    // "Previously not kept" is nest history: only in a room of readers.
    note: held && binding.surface_ok ? `Previously not kept on ${held}` : null,
    compare_url: cardItems[0] ? draftUrl(cardItems[0].id) : null,
    outcome,
  };
}

/** R2: approve-with-edits needs edit rights; the channel card shows Edit only
 *  when its named reviewer has them on every item. */
export async function reviewerCanEdit(nestId: string, userId: string | null, items: Array<{ node_id: string | null }>): Promise<boolean> {
  if (!userId || !items.length) return false;
  const u = (await getDb().get("SELECT email FROM users WHERE id = ?", [userId])) as { email: string } | undefined;
  if (!u) return false;
  const { canUserEdit } = await import("../../governance/stewardship-service.js");
  for (const it of items) {
    if (!it.node_id) return false;
    const v = await canUserEdit(nestId, it.node_id, u.email).catch(() => ({ allowed: false }));
    if (!v.allowed) return false;
  }
  return true;
}

function viewOf(m: CardModel, threadRef: string | null): ProposalView {
  const it = m.items[0];
  return {
    proposal_id: m.proposal_id,
    kind: m.kind,
    title: it?.title ?? "",
    summary: it?.summary ?? "",
    folder: it?.folder ?? "",
    nest_name: m.nest_name,
    draft_url: it?.draft_url ?? "",
    thread_ref: threadRef,
    card: m,
  };
}

async function threadRefFor(p: ProposalRow, binding: BindingRow): Promise<string | null> {
  if (binding.conversation_kind === "dm") return null;
  const w = (await getDb().get("SELECT thread_key, forced_target_id FROM surface_windows WHERE id = ?", [p.window_id])) as
    | { thread_key: string; forced_target_id: string | null }
    | undefined;
  if (!w) return null;
  return w.thread_key !== "channel" ? w.thread_key : w.forced_target_id;
}

async function context(proposalId: string): Promise<{ p: ProposalRow; binding: BindingRow; install: InstallRow } | null> {
  const p = await getProposal(proposalId);
  if (!p) return null;
  const binding = await getBindingRow(p.binding_id);
  if (!binding) return null;
  const install = await getInstall(binding.install_id);
  if (!install) return null;
  return { p, binding, install };
}

/**
 * Post a queued/held proposal's card into its own conversation (thread).
 * Returns true when this call posted it. Never posts into a binding that
 * isn't active and capturing, and never resurrects a withdrawn proposal.
 */
export async function postCard(proposalId: string): Promise<boolean> {
  const ctx = await context(proposalId);
  if (!ctx) return false;
  const { p, binding, install } = ctx;
  if (p.state !== "held" && p.state !== "queued") return false;
  if (binding.status !== "active" || !binding.capture_ok) return false;
  const connector = getConnector(install.surface);
  if (!connector) return false;
  const items = (await getItems(p.id)).filter((i) => i.state === "pending");
  if (!items.length) return false;
  const claim = await getDb().run(
    "UPDATE surface_proposals SET card_ref = 'posting', updated_at = ? WHERE id = ? AND card_ref IS NULL AND state IN ('held', 'queued')",
    [nowIso(), p.id],
  );
  if (claim.changes === 0) return false;
  const model = await buildCardModel(p, binding, items);
  await cardTestHooks.beforePost?.(binding.id);
  // M2: a DM card is posted only while DM capture is still allowed.
  if (binding.conversation_kind === "dm") {
    const { dmCaptureAllowed } = await import("./dm-service.js");
    const live = await getBindingRow(binding.id);
    if (!live || !(await dmCaptureAllowed(live))) {
      await getDb().run("UPDATE surface_proposals SET card_ref = NULL WHERE id = ? AND card_ref = 'posting'", [p.id]);
      return false;
    }
  }
  let ref: CardRef;
  try {
    ref = await connector.postProposal(bindingRef(binding), viewOf(model, await threadRefFor(p, binding)));
  } catch {
    await getDb().run("UPDATE surface_proposals SET card_ref = NULL WHERE id = ? AND card_ref = 'posting'", [p.id]);
    return false;
  }
  const at = nowIso();
  const done = await getDb().run(
    "UPDATE surface_proposals SET state = 'posted', card_ref = ?, posted_at = ?, updated_at = ? WHERE id = ? AND state IN ('held', 'queued')",
    [JSON.stringify(ref), at, at, p.id],
  );
  if (done.changes === 0) {
    // Withdrawn or expired while we posted: keep the ref and show that outcome.
    await getDb().run("UPDATE surface_proposals SET card_ref = ? WHERE id = ?", [JSON.stringify(ref), p.id]);
    const now = await getProposal(p.id);
    if (now && (now.state === "withdrawn" || now.state === "expired")) {
      const title = items[0]?.title ?? "this proposal";
      await updateCardOnce(p.id, now.state === "withdrawn" ? { type: "withdrawn", title } : { type: "expired", title }, [items[0]].filter(Boolean) as ItemRow[]);
    }
    return false;
  }
  if (binding.conversation_kind === "dm") {
    await getDb().run("UPDATE surface_bindings SET dm_intro_card_at = ? WHERE id = ? AND dm_intro_card_at IS NULL", [at, binding.id]);
  }
  // M1(d): surface_ok dropped while we posted (the card was rendered for a
  // room of readers): redact it now, through the retrying path.
  const after = await getBindingRow(binding.id);
  if (model.surface_ok && (!after || !after.surface_ok)) {
    await getDb().run("UPDATE surface_proposals SET redaction_pending = 1, redaction_next_at = NULL WHERE id = ?", [p.id]);
    await redactOne(p.id);
  }
  return true;
}

export function parseRef(raw: string | null): CardRef | null {
  if (!raw || raw === "posting") return null;
  try {
    const r = JSON.parse(raw) as CardRef;
    return r && typeof r.message_ref === "string" ? r : null;
  } catch {
    return null;
  }
}

/**
 * Update a posted card in place with an outcome — the first attempt of THE
 * one retrying path (security round M1). `items` are the rows as they were
 * BEFORE any purge (titles intact). Nothing is marked done before Slack
 * confirms: a failure leaves the card `redaction_pending` with a backoff,
 * and the sweep re-renders it from the rows (redacted / generic) until it
 * succeeds, falls back to chat.delete, or gives up with one admin alert.
 */
export async function updateCardOnce(proposalId: string, outcome: CardOutcome, itemsBefore?: ItemRow[]): Promise<boolean> {
  const ctx = await context(proposalId);
  if (!ctx) return false;
  const { p, binding, install } = ctx;
  const ref = parseRef(p.card_ref);
  if (!ref) return false;
  const connector = getConnector(install.surface);
  if (!connector) return false;
  const model = await buildCardModel(p, binding, itemsBefore ?? (await getItems(p.id)), outcome);
  try {
    await connector.updateProposal(ref, viewOf(model, null));
  } catch (err) {
    await cardUpdateFailed(p.id, err);
    return false;
  }
  await getDb().run("UPDATE surface_proposals SET outcome_rendered = ?, updated_at = ? WHERE id = ?", [outcome.type, nowIso(), p.id]);
  return true;
}

// ─── the one retrying card-update path (security round M1) ──────────────────

export const REDACTION_MAX_ATTEMPTS = 8;
/** Slack errors after which an update can never succeed. */
const PERMANENT = new Set(["message_not_found", "channel_not_found", "cant_update_message", "is_archived", "not_in_channel", "edit_window_closed"]);

/** Tests only. */
export const cardTestHooks: { beforePost?: (bindingId: string) => Promise<void> | void } = {};

function errCode(err: unknown): string | null {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : null;
}

/** A card update failed: retry later with backoff, or give up properly. */
async function cardUpdateFailed(proposalId: string, err: unknown): Promise<void> {
  const row = (await getDb().get("SELECT redaction_attempts FROM surface_proposals WHERE id = ?", [proposalId])) as { redaction_attempts: number } | undefined;
  const attempts = Number(row?.redaction_attempts ?? 0) + 1;
  const code = errCode(err);
  if ((code && PERMANENT.has(code)) || attempts >= REDACTION_MAX_ATTEMPTS) {
    await giveUp(proposalId, attempts);
    return;
  }
  const backoffMs = Math.min(2 ** attempts * 60_000, 60 * 60_000);
  await getDb().run("UPDATE surface_proposals SET redaction_pending = 1, redaction_attempts = ?, redaction_next_at = ?, updated_at = ? WHERE id = ?", [
    attempts,
    new Date(Date.now() + backoffMs).toISOString(),
    nowIso(),
    proposalId,
  ]);
}

/** Permanent failure: try to delete the card; else mark it failed and alert admins ONCE (counts and a permalink only). */
async function giveUp(proposalId: string, attempts: number): Promise<void> {
  const ctx = await context(proposalId);
  if (!ctx) return;
  const { p, binding, install } = ctx;
  const ref = parseRef(p.card_ref);
  const connector = getConnector(install.surface);
  if (ref && connector?.deleteProposal) {
    try {
      await connector.deleteProposal(installRef(install), ref);
      await getDb().run("UPDATE surface_proposals SET redaction_pending = 0, redaction_attempts = ?, redaction_next_at = NULL, outcome_rendered = 'deleted', updated_at = ? WHERE id = ?", [
        attempts,
        nowIso(),
        p.id,
      ]);
      return;
    } catch {
      /* fall through */
    }
  }
  const first = await getDb().run(
    "UPDATE surface_proposals SET redaction_pending = 0, redaction_failed = 1, redaction_attempts = ?, redaction_next_at = NULL, updated_at = ? WHERE id = ? AND redaction_failed = 0",
    [attempts, nowIso(), p.id],
  );
  if (first.changes === 0) return;
  let permalink: string | null = null;
  if (ref && connector?.permalink) permalink = await connector.permalink(installRef(install), ref.conversation, ref.message_ref).catch(() => null);
  const { recordNotice } = await import("./notices.js");
  await recordNotice({
    kind: "card_redaction_failed",
    audience: "admins",
    bindingId: binding.id,
    nestId: p.nest_id,
    detail: { proposal_id: p.id, attempts, permalink },
    subject: "Nest couldn't redact a card",
    text: `A Nest card could not be updated or deleted after ${attempts} attempt(s), so it may still show text that some people in that conversation can't read. Remove it by hand${permalink ? `: ${permalink}` : ""}.`,
  }).catch(() => "");
}

/**
 * After S2a's createProposal: store what the card needs once the buffer is
 * purged — each item's summary, why and on-record claim — plus the window guard, message count,
 * time range, requester and the proposal's confidence. Never message text.
 */
export async function annotateProposal(input: {
  proposalId: string;
  items: Array<{ id: string; title: string; folder: string }>;
  verdictItems: Array<{ title: string; target_folder: string; summary: string; why: string; confidence: number; conflict: { on_record_claim: string } | null }>;
  windowTexts: string[];
  tss: string[];
  requestedBy: string | null;
  guard: unknown;
}): Promise<void> {
  const used = new Set<number>();
  let conf = 0;
  for (const it of input.items) {
    const idx = input.verdictItems.findIndex((v, i) => !used.has(i) && v.title.trim() === it.title.trim() && v.target_folder === it.folder);
    if (idx < 0) continue;
    used.add(idx);
    const v = input.verdictItems[idx];
    conf = Math.max(conf, v.confidence);
    await getDb().run("UPDATE surface_proposal_items SET summary = ?, why = ?, on_record = ? WHERE id = ?", [
      v.summary,
      v.why || null,
      v.conflict?.on_record_claim ?? null,
      it.id,
    ]);
  }
  const sorted = [...input.tss].sort((a, b) => Number(a) - Number(b));
  await getDb().run(
    "UPDATE surface_proposals SET confidence = ?, window_guard = ?, message_count = ?, first_ts = ?, last_ts = ?, requested_by_surface_user_id = ? WHERE id = ?",
    [conf, input.guard ? JSON.stringify(input.guard) : null, input.tss.length, sorted[0] ?? null, sorted[sorted.length - 1] ?? null, input.requestedBy, input.proposalId],
  );
}


// ─── §4.17: redaction when surface_ok turns false ───────────────────────────

/** The outcome a decided card shows, rebuilt from the rows (no titles needed:
 *  the redacted variant never shows them). */
async function storedOutcome(p: ProposalRow, items: ItemRow[], installId: string): Promise<CardOutcome | null> {
  if (p.state === "expired") return { type: "expired", title: "this proposal" };
  if (p.state === "withdrawn") return { type: "withdrawn", title: "this proposal" };
  if (p.state !== "decided") return null;
  const approved = items.filter((i) => i.state === "approved");
  const decider = (approved[0] ?? items.find((i) => i.state === "rejected"))?.decided_by_user_id ?? null;
  const by = (await mentionFor(installId, decider)) ?? "a reviewer";
  if (approved.length) {
    return { type: "approved", by, kept: approved.map((i) => ({ path: "a record", version: i.version })), notKept: items.filter((i) => i.state === "rejected").map(() => "an item"), editedBy: null };
  }
  const r = items.find((i) => i.state === "rejected")?.reason ?? null;
  return { type: "rejected", by, reason: (r as Extract<CardOutcome, { type: "rejected" }>["reason"]) ?? null };
}

async function redactOne(proposalId: string): Promise<boolean> {
  const ctx = await context(proposalId);
  if (!ctx) return false;
  const { p, binding, install } = ctx;
  const ref = parseRef(p.card_ref);
  const connector = getConnector(install.surface);
  if (!ref || !connector) {
    await getDb().run("UPDATE surface_proposals SET redaction_pending = 0 WHERE id = ?", [p.id]);
    return true;
  }
  // The retry renders from the rows: the redacted variant when the room isn't
  // all readers (or after a pause), never more than the first attempt showed.
  const redactedBinding = { ...binding, surface_ok: binding.status === "active" ? binding.surface_ok : 0 } as BindingRow;
  const items = await getItems(p.id);
  const outcome = await storedOutcome(p, items, install.id);
  const model = await buildCardModel(p, redactedBinding, items, outcome);
  try {
    await connector.updateProposal(ref, viewOf(model, null));
  } catch (err) {
    await cardUpdateFailed(p.id, err); // stays pending with backoff, or gives up properly
    return false;
  }
  await getDb().run("UPDATE surface_proposals SET redaction_pending = 0, redaction_attempts = 0, redaction_next_at = NULL, updated_at = ? WHERE id = ?", [nowIso(), p.id]);
  return true;
}

/**
 * Every card already posted in this binding's conversation goes to the
 * redacted variant. Marked `redaction_pending` first, so a failure (or a
 * crash) is retried by the next guard sweep until it succeeds.
 */
export async function redactBindingCards(bindingId: string): Promise<number> {
  await getDb().run(
    "UPDATE surface_proposals SET redaction_pending = 1, redaction_next_at = NULL, updated_at = ? WHERE binding_id = ? AND card_ref IS NOT NULL AND card_ref <> 'posting' AND redaction_failed = 0",
    [nowIso(), bindingId],
  );
  return retryRedactions(bindingId);
}

export async function retryRedactions(bindingId?: string, nowMs = Date.now()): Promise<number> {
  const rows = (await getDb().all(
    `SELECT id FROM surface_proposals WHERE redaction_pending = 1 AND redaction_failed = 0 AND (redaction_next_at IS NULL OR redaction_next_at <= ?)
       ${bindingId ? "AND binding_id = ?" : ""} ORDER BY created_at`,
    bindingId ? [new Date(nowMs).toISOString(), bindingId] : [new Date(nowMs).toISOString()],
  )) as Array<{ id: string }>;
  let n = 0;
  for (const r of rows) if (await redactOne(r.id)) n++;
  return n;
}

export { reconcileStuckClaims } from "./commit-service.js";
