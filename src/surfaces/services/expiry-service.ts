/**
 * Expiry and withdrawal of cards (PRD §4.16, AC-EXP-*).
 *
 *  - Expiry (every 15 min): items pending past `expires_at` in queued, held
 *    or posted proposals → `expired`; a posted card is updated ONCE in place
 *    (no mention, no new message, no DM); the draft is purged and a 7-day
 *    hold written.
 *  - Withdrawal (binding paused / booted / removed, DM capture off, uninstall,
 *    admin disconnect): the card is updated in place while a token exists
 *    ("Withdrawn…"), then S2a's withdraw purges the draft — NO hold.
 *
 * Every item is claimed with the same `decide:<item>` key commits use, so an
 * approve racing an expiry or a withdrawal has exactly one winner.
 */
import { getDb } from "../../db/client.js";
import { purgeSurfaceDraft } from "./draft-purge.js";
import { getBindingRow } from "./binding-service.js";
import { getItems, getProposal, updateCardOnce, type ItemRow } from "./card-service.js";
import { claimItem, purgeAndHold } from "./commit-service.js";
import { withdrawProposalItems } from "./proposal-service.js";

const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** Wait (bounded) for an in-flight commit on these items to finish. */
async function settleInFlight(itemIds: string[], timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const busy = (await getDb().get(
      `SELECT COUNT(*) AS n FROM surface_actions WHERE status = 'in_progress' AND idempotency_key IN (${itemIds.map(() => "?").join(", ")})`,
      itemIds.map((i) => `decide:${i}`),
    )) as { n: number | string };
    if (Number(busy.n) === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Withdraw one proposal's pending items with the card updated first.
 * Returns the number of items withdrawn.
 */
export async function withdrawWithCard(proposalId: string): Promise<number> {
  const before = await getItems(proposalId);
  const pending = before.filter((i) => i.state === "pending");
  if (!pending.length) return 0;
  const lost: string[] = [];
  for (const it of pending) if (!(await claimItem(it.id, "withdraw"))) lost.push(it.id);
  if (lost.length) await settleInFlight(lost);
  const still = (await getItems(proposalId)).filter((i) => i.state === "pending");
  if (!still.length) return 0;
  const title = still[0].title ?? "this proposal";
  const p = await getProposal(proposalId);
  if (p && p.state === "posted") await updateCardOnce(proposalId, { type: "withdrawn", title }, before);
  const n = await withdrawProposalItems(proposalId);
  for (const it of still) {
    await getDb().run("UPDATE surface_actions SET status = 'done', updated_at = ? WHERE idempotency_key = ? AND action = 'withdraw'", [iso(), `decide:${it.id}`]);
  }
  await getDb().run("UPDATE surface_proposals SET window_guard = NULL WHERE id = ?", [proposalId]);
  return n;
}

/** Withdraw every pending proposal of a binding (cards first). */
export async function withdrawBindingCards(bindingId: string): Promise<number> {
  const rows = (await getDb().all(
    "SELECT DISTINCT p.id FROM surface_proposals p JOIN surface_proposal_items i ON i.proposal_id = p.id WHERE p.binding_id = ? AND i.state = 'pending'",
    [bindingId],
  )) as Array<{ id: string }>;
  let n = 0;
  for (const r of rows) n += await withdrawWithCard(r.id);
  return n;
}

async function expireOne(proposalId: string, nowMs: number): Promise<number> {
  const p = await getProposal(proposalId);
  if (!p) return 0;
  const binding = await getBindingRow(p.binding_id);
  if (!binding) return 0;
  const before = await getItems(p.id);
  const mine: ItemRow[] = [];
  for (const it of before.filter((i) => i.state === "pending")) if (await claimItem(it.id, "expire")) mine.push(it);
  if (!mine.length) return 0;
  if (p.state === "posted") await updateCardOnce(p.id, { type: "expired", title: mine[0].title ?? "this proposal" }, before);
  for (const it of mine) {
    const r = await getDb().run("UPDATE surface_proposal_items SET state = 'expired', decided_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'", [
      iso(nowMs),
      iso(nowMs),
      it.id,
    ]);
    if (r.changes === 0) continue;
    // Cancel the pending review; purgeAndHold then discards the draft and holds.
    if (it.node_id) await purgeSurfaceDraft({ nestId: it.nest_id, nodeId: it.node_id, reviewId: it.review_id, proposalId: it.proposal_id, cancel: true, discard: false, reason: "expired" });
    await purgeAndHold(binding, it, "expired", nowMs);
    await getDb().run("UPDATE surface_actions SET status = 'done', updated_at = ? WHERE idempotency_key = ?", [iso(), `decide:${it.id}`]);
  }
  const left = (await getDb().get("SELECT COUNT(*) AS n FROM surface_proposal_items WHERE proposal_id = ? AND state = 'pending'", [p.id])) as { n: number | string };
  if (Number(left.n) === 0) {
    await getDb().run("UPDATE surface_proposals SET state = 'expired', window_guard = NULL, updated_at = ? WHERE id = ? AND state IN ('queued', 'held', 'posted')", [
      iso(nowMs),
      p.id,
    ]);
  }
  return mine.length;
}

/** The expiry job: every proposal past its 7 days, in any undecided state. */
export async function expireDue(nowMs = Date.now()): Promise<number> {
  // L6: a claim stuck in progress must never make an item un-expirable.
  const { reconcileStuckClaims } = await import("./commit-service.js");
  await reconcileStuckClaims(nowMs);
  const due = (await getDb().all("SELECT id FROM surface_proposals WHERE state IN ('queued', 'held', 'posted') AND expires_at <= ?", [iso(nowMs)])) as Array<{
    id: string;
  }>;
  let n = 0;
  for (const d of due) n += await expireOne(d.id, nowMs);
  return n;
}
