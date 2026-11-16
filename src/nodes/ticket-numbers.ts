/**
 * Ticket numbers — sequential per (nest, prefix), never handed out twice.
 *
 * The counter is one row per prefix and the next value comes from a single
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` statement. A statement is
 * atomic on both SQLite and PostgreSQL: two creates racing for CM-124 are
 * serialized by the row lock and get 124 and 125, never the same number. There
 * is no read-then-write window to lose.
 *
 * Numbers are unique and only ever increase. A create that fails after its
 * number was drawn leaves a gap — that is the price of never reusing one, and
 * it keeps a number that appeared anywhere (a PR title, a Slack message)
 * pointing at one ticket forever.
 */
import { getDb } from "../db/client.js";
import type { Querier } from "../db/adapter.js";
import { formatTicket, ticketFromTag, ticketTagOf, type TaskRules } from "./task-rules.js";
import { readIndexedNodes, ensureNodeIndex } from "./node-index.js";

/** Draw the next number for `prefix` in this nest. */
export async function allocateTicketNumber(
  nestId: string,
  prefix: string,
  q: Querier = getDb(),
): Promise<number> {
  const row = await q.get<{ last_value: number | string }>(
    `INSERT INTO nest_ticket_counters (nest_id, prefix, last_value)
     VALUES (?, ?, 1)
     ON CONFLICT (nest_id, prefix)
     DO UPDATE SET last_value = nest_ticket_counters.last_value + 1
     RETURNING last_value`,
    [nestId, prefix],
  );
  if (!row) throw new Error("ticket counter returned no row");
  return Number(row.last_value);
}

/** The ticket id (`CM-124`) for the next task of this prefix. */
export async function allocateTicket(
  nestId: string,
  prefix: string,
  q: Querier = getDb(),
): Promise<string> {
  return formatTicket(prefix, await allocateTicketNumber(nestId, prefix, q));
}

/** Last number handed out for a prefix (0 when none). */
export async function ticketCounter(
  nestId: string,
  prefix: string,
  q: Querier = getDb(),
): Promise<number> {
  const row = await q.get<{ last_value: number | string }>(
    "SELECT last_value FROM nest_ticket_counters WHERE nest_id = ? AND prefix = ?",
    [nestId, prefix],
  );
  return row ? Number(row.last_value) : 0;
}

/** Raise a counter to at least `n`, never lowering it. Used after a backfill so
 *  the next live create continues from the highest number given. */
export async function raiseTicketCounter(
  nestId: string,
  prefix: string,
  n: number,
  q: Querier = getDb(),
): Promise<void> {
  await q.run(
    `INSERT INTO nest_ticket_counters (nest_id, prefix, last_value)
     VALUES (?, ?, ?)
     ON CONFLICT (nest_id, prefix)
     DO UPDATE SET last_value = CASE
       WHEN nest_ticket_counters.last_value < excluded.last_value
       THEN excluded.last_value ELSE nest_ticket_counters.last_value END`,
    [nestId, prefix, n],
  );
}

/**
 * Bring the nest's counter in line with the tickets it already holds, so the
 * next live create can never repeat a number. Two sources:
 *   - `ticket_start_at` (a team continuing another tracker's sequence);
 *   - ticket tags already on tasks under the nest's prefix — an imported nest,
 *     or numbers stamped before the counter existed. The counter rises to the
 *     highest number found.
 * Tickets issued under an earlier prefix keep their numbers and don't count:
 * the prefix is part of the ticket, so `OLD-9` never collides with `NEW-9`.
 * The counter only ever goes up, so this is safe to run any number of times.
 * Returns the prefixes it raised (empty when numbering is off).
 */
export async function syncTicketCounters(nestId: string, rules: TaskRules): Promise<string[]> {
  const prefix = rules.ticket_prefix;
  if (!prefix) return [];
  let target = rules.ticket_start_at && rules.ticket_start_at > 1 ? rules.ticket_start_at - 1 : 0;

  await ensureNodeIndex(nestId);
  for (const n of await readIndexedNodes(nestId)) {
    const tag = ticketTagOf((n.frontmatter.tags || []) as string[]);
    const id = tag ? ticketFromTag(tag) : null;
    if (!id) continue;
    const dash = id.lastIndexOf("-");
    if (id.slice(0, dash) !== prefix) continue;
    const num = Number(id.slice(dash + 1));
    if (Number.isFinite(num) && num > target) target = num;
  }
  if (target > 0 && (await ticketCounter(nestId, prefix)) < target) {
    await raiseTicketCounter(nestId, prefix, target);
    return [prefix];
  }
  return [];
}
