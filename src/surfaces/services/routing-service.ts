/**
 * Reviewer routing, budgets and the queue (PRD §4.8, AC-BUD-*).
 *
 *  - Eligible reviewers: Community users who pass canUserApprove on every
 *    item and map to a current member of the source conversation (guests,
 *    externals and bots never map).
 *  - Order: folder owner (V15: Community has no folder owners — skipped),
 *    fewest pending, least recently named.
 *  - Organic: the conversation's daily cap, then the first reviewer with
 *    budget left today posts; nobody with budget → queued for the
 *    first-ranked, released at 09:00 next org day. A full queue (10) drops
 *    the lowest-confidence proposal (`queue_overflow`, draft purged, no hold).
 *  - Explicit asks post at once and never count (AC-BUD-05).
 *  - No eligible reviewer → held (N4), visible in My pending.
 *
 * Daily usage is claimed with a conditional upsert, so two concurrent
 * routings can't both take a reviewer's last card. N2: queue state never
 * appears on a channel card.
 */
import { getDb } from "../../db/client.js";
import { ORG_ID } from "../flags.js";
import { canUserApprove } from "../../governance/stewardship-service.js";
import { resolveNestPermission, permissionLevel } from "../../shared/access.js";
import { nextReleaseAt, orgDay, pickOverflow, QUEUE_MAX, route } from "../core/budget.js";
import { rankReviewers, type ReviewerStats } from "../core/reviewers.js";
import { getConnector } from "../registry.js";
import { getBindingRow, type BindingRow } from "./binding-service.js";
import { getInstall, installRef, homeTenant } from "./install-store.js";
import { resolveIdentity } from "./identity-service.js";
import { safeMembers } from "./members.js";
import { getSettings } from "./settings-service.js";
import { getItems, getProposal, postCard, type ItemRow, type ProposalRow } from "./card-service.js";
import { withdrawProposalItems } from "./proposal-service.js";

const iso = (ms: number) => new Date(ms).toISOString();

async function userEmail(userId: string): Promise<string | null> {
  const r = (await getDb().get("SELECT email, is_service FROM users WHERE id = ?", [userId])) as { email: string; is_service: number | null } | undefined;
  return r && !r.is_service ? r.email : null;
}

/** Does this Community user read the nest and pass canUserApprove on every item? */
export async function canReviewAll(nestId: string, userId: string, items: Array<Pick<ItemRow, "node_id">>): Promise<boolean> {
  const email = await userEmail(userId);
  if (!email) return false;
  try {
    if (permissionLevel(await resolveNestPermission(nestId, userId)) < permissionLevel("read")) return false;
  } catch {
    return false;
  }
  for (const it of items) {
    if (!it.node_id) return false;
    const v = await canUserApprove(nestId, it.node_id, email).catch(() => ({ allowed: false }));
    if (!v.allowed) return false;
  }
  return true;
}

/** Community users mapped from the conversation's current members (fail closed: unknown → none). */
export async function conversationUsers(binding: BindingRow): Promise<{ known: boolean; users: Map<string, string> }> {
  const install = await getInstall(binding.install_id);
  if (!install) return { known: false, users: new Map() };
  const m = await safeMembers(getConnector(install.surface), installRef(install), binding.conversation_id);
  if (!m.known) return { known: false, users: new Map() };
  const users = new Map<string, string>(); // community user → surface user
  const home = homeTenant(install);
  for (const mem of m.members) {
    if (mem.is_bot || mem.is_guest || mem.is_external || (mem.home_tenant && mem.home_tenant !== home)) continue;
    const u = await resolveIdentity(install.id, mem.surface_user_id).catch(() => null);
    if (u && !users.has(u)) users.set(u, mem.surface_user_id);
  }
  return { known: true, users };
}

/** Eligible reviewers for a proposal in its conversation (§4.8). */
export async function eligibleReviewers(p: ProposalRow, binding: BindingRow, items: ItemRow[]): Promise<{ eligible: string[]; members: Map<string, string> }> {
  const { users } = await conversationUsers(binding);
  const pending = items.filter((i) => i.state === "pending");
  const eligible: string[] = [];
  for (const u of users.keys()) if (await canReviewAll(p.nest_id, u, pending)) eligible.push(u);
  return { eligible, members: users };
}

async function stats(userIds: string[], day: string): Promise<ReviewerStats[]> {
  const out: ReviewerStats[] = [];
  for (const u of userIds) {
    const pend = (await getDb().get(
      `SELECT COUNT(*) AS n FROM surface_proposals WHERE named_reviewer_user_id = ? AND state IN ('posted', 'queued')`,
      [u],
    )) as { n: number | string };
    const last = (await getDb().get(
      "SELECT MAX(COALESCE(posted_at, updated_at)) AS at FROM surface_proposals WHERE named_reviewer_user_id = ? AND state <> 'held'",
      [u],
    )) as { at: string | null };
    const used = (await getDb().get("SELECT cards_posted FROM surface_reviewer_usage WHERE user_id = ? AND day = ?", [u, day])) as
      | { cards_posted: number }
      | undefined;
    out.push({ userId: u, pending: Number(pend.n), lastNamedAt: last?.at ?? null, usedToday: Number(used?.cards_posted ?? 0) });
  }
  return out;
}

async function claimReviewer(userId: string, day: string, limit: number): Promise<boolean> {
  const r = await getDb().run(
    `INSERT INTO surface_reviewer_usage (user_id, org_id, day, cards_posted, created_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (user_id, day) DO UPDATE SET cards_posted = surface_reviewer_usage.cards_posted + 1 WHERE surface_reviewer_usage.cards_posted < ?`,
    [userId, ORG_ID, day, iso(Date.now()), limit],
  );
  return r.changes > 0;
}
async function releaseReviewer(userId: string, day: string): Promise<void> {
  await getDb().run("UPDATE surface_reviewer_usage SET cards_posted = cards_posted - 1 WHERE user_id = ? AND day = ? AND cards_posted > 0", [userId, day]);
}
async function claimConversation(bindingId: string, day: string, limit: number): Promise<boolean> {
  const r = await getDb().run(
    `INSERT INTO surface_conversation_usage (binding_id, day, cards_posted, created_at) VALUES (?, ?, 1, ?)
     ON CONFLICT (binding_id, day) DO UPDATE SET cards_posted = surface_conversation_usage.cards_posted + 1 WHERE surface_conversation_usage.cards_posted < ?`,
    [bindingId, day, iso(Date.now()), limit],
  );
  return r.changes > 0;
}
async function releaseConversation(bindingId: string, day: string): Promise<void> {
  await getDb().run("UPDATE surface_conversation_usage SET cards_posted = cards_posted - 1 WHERE binding_id = ? AND day = ? AND cards_posted > 0", [bindingId, day]);
}
async function conversationPosted(bindingId: string, day: string): Promise<number> {
  const r = (await getDb().get("SELECT cards_posted FROM surface_conversation_usage WHERE binding_id = ? AND day = ?", [bindingId, day])) as
    | { cards_posted: number }
    | undefined;
  return Number(r?.cards_posted ?? 0);
}

async function setNamed(proposalId: string, userId: string | null): Promise<void> {
  await getDb().run("UPDATE surface_proposals SET named_reviewer_user_id = ?, updated_at = ? WHERE id = ?", [userId, iso(Date.now()), proposalId]);
}

/** Post organically for `userId`, claiming both daily budgets; false = couldn't. */
async function postCounted(p: ProposalRow, binding: BindingRow, userId: string, day: string, s: { reviewer: number; conversation: number }): Promise<"posted" | "reviewer_full" | "conversation_full" | "failed"> {
  if (!(await claimReviewer(userId, day, s.reviewer))) return "reviewer_full";
  if (!(await claimConversation(binding.id, day, s.conversation))) {
    await releaseReviewer(userId, day);
    return "conversation_full";
  }
  await setNamed(p.id, userId);
  if (await postCard(p.id)) return "posted";
  await releaseReviewer(userId, day);
  await releaseConversation(binding.id, day);
  return "failed";
}

async function enqueue(p: ProposalRow, reviewer: string, reason: "budget" | "capped", nowMs: number, tz: string): Promise<"queued" | "dropped"> {
  await getDb().run(
    `UPDATE surface_proposals SET state = 'queued', named_reviewer_user_id = ?, queue_reason = ?, queued_release_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('held', 'queued')`,
    [reviewer, reason, iso(nextReleaseAt(nowMs, tz)), iso(nowMs), p.id],
  );
  const queued = (await getDb().all(
    "SELECT id, confidence, created_at FROM surface_proposals WHERE named_reviewer_user_id = ? AND state = 'queued' AND id <> ? ORDER BY created_at",
    [reviewer, p.id],
  )) as Array<{ id: string; confidence: number | null; created_at: string }>;
  const norm = (x: { id: string; confidence: number | null; created_at: string }) => ({ ...x, confidence: Number(x.confidence ?? 0) });
  const drop = pickOverflow(queued.map(norm), norm({ id: p.id, confidence: p.confidence, created_at: p.created_at }), QUEUE_MAX);
  if (drop) {
    await dropOverflow(drop.id);
    return drop.id === p.id ? "dropped" : "queued";
  }
  return "queued";
}

/** queue_overflow: draft purged, items 'dropped', NO hold. */
async function dropOverflow(proposalId: string): Promise<void> {
  await withdrawProposalItems(proposalId);
  await getDb().run("UPDATE surface_proposal_items SET state = 'dropped', reason = 'queue_overflow' WHERE proposal_id = ? AND state = 'withdrawn'", [proposalId]);
}

export type RouteOutcome = "posted" | "queued" | "held" | "dropped" | "skipped";

/** Route a freshly created proposal (S2a creates it `held`). */
export async function routeNewProposal(proposalId: string, nowMs = Date.now()): Promise<RouteOutcome> {
  const p = await getProposal(proposalId);
  if (!p || p.state !== "held") return "skipped";
  const binding = await getBindingRow(p.binding_id);
  if (!binding || binding.status !== "active" || !binding.capture_ok) return "skipped";
  const items = await getItems(p.id);
  const settings = await getSettings();
  const tz = settings.timezone || "UTC";
  const day = orgDay(nowMs, tz);
  const { eligible } = await eligibleReviewers(p, binding, items);
  const ranked = rankReviewers(await stats(eligible, day));
  const decision = route({
    forced: !!p.forced,
    ranked,
    hasAnyApprover: !binding.explicit_public_bind ? false : true,
    reviewerDailyCards: settings.reviewer_daily_cards,
    conversationPostedToday: await conversationPosted(binding.id, day),
    conversationDailyCards: settings.conversation_daily_cards,
  });
  if (decision.action === "hold") {
    await getDb().run("UPDATE surface_proposals SET hold_reason = ?, named_reviewer_user_id = NULL, updated_at = ? WHERE id = ? AND state = 'held'", [
      binding.explicit_public_bind ? "none_in_conversation" : decision.reason,
      iso(nowMs),
      p.id,
    ]);
    return "held";
  }
  if (decision.action === "post" && !decision.countsAgainstBudget) {
    await setNamed(p.id, decision.reviewer);
    return (await postCard(p.id)) ? "posted" : "held";
  }
  if (decision.action === "post") {
    // Try reviewers in rank order; a lost race moves to the next.
    for (const r of ranked) {
      const res = await postCounted(p, binding, r.userId, day, { reviewer: settings.reviewer_daily_cards, conversation: settings.conversation_daily_cards });
      if (res === "posted") return "posted";
      if (res === "conversation_full") return enqueue(p, ranked[0].userId, "capped", nowMs, tz);
      if (res === "failed") return "held";
    }
    return enqueue(p, ranked[0].userId, "budget", nowMs, tz);
  }
  return enqueue(p, decision.reviewer, decision.reason, nowMs, tz);
}

/**
 * Queue release (hourly; proposals post at 09:00 org time): due proposals
 * post in their original threads, each counting against that day's limit;
 * those that don't fit stay queued for the next release.
 */
export async function releaseQueue(nowMs = Date.now()): Promise<number> {
  const settings = await getSettings();
  const tz = settings.timezone || "UTC";
  const day = orgDay(nowMs, tz);
  const due = (await getDb().all("SELECT id FROM surface_proposals WHERE state = 'queued' AND queued_release_at <= ? ORDER BY created_at", [iso(nowMs)])) as Array<{
    id: string;
  }>;
  let posted = 0;
  for (const { id } of due) {
    const p = await getProposal(id);
    if (!p || p.state !== "queued" || !p.named_reviewer_user_id) continue;
    const binding = await getBindingRow(p.binding_id);
    if (!binding || binding.status !== "active" || !binding.capture_ok) continue;
    const res = await postCounted(p, binding, p.named_reviewer_user_id, day, { reviewer: settings.reviewer_daily_cards, conversation: settings.conversation_daily_cards });
    if (res === "posted") posted++;
    else await getDb().run("UPDATE surface_proposals SET queued_release_at = ? WHERE id = ? AND state = 'queued'", [iso(nextReleaseAt(nowMs, tz)), p.id]);
  }
  return posted;
}

/** Held proposals waiting from S2a (or a restart): route them. */
export async function routeHeldBacklog(nowMs = Date.now()): Promise<number> {
  const rows = (await getDb().all("SELECT id FROM surface_proposals WHERE state = 'held' AND hold_reason IS NULL AND card_ref IS NULL", [])) as Array<{ id: string }>;
  let n = 0;
  for (const r of rows) if ((await routeNewProposal(r.id, nowMs)) !== "skipped") n++;
  return n;
}
