/**
 * Number the tasks a nest already has, oldest first.
 *
 * Live numbering (createNode) only reaches tasks created after it is turned on.
 * This gives every existing task without a ticket tag its number, in created_at
 * order (ties by id), so CM-1 is the oldest community ticket. It uses the same
 * counter as live creates, so a task filed while the backfill runs simply gets
 * the next number — nothing can clash.
 *
 * Re-runnable: a task that already has a ticket tag is skipped, so a run cut
 * short by a timeout is finished by running it again. `limit` bounds one call
 * (each task is a full governed write).
 */
import { readIndexedNodes, ensureNodeIndex } from "./node-index.js";
import { updateNode } from "./service.js";
import { nestTaskRules, storeDefaultTaskRules } from "../nests/service.js";
import { allocateTicket, syncTicketCounters } from "./ticket-numbers.js";
import { ticketPrefixOf, ticketTag, ticketTagOf } from "./task-rules.js";
import { TASK_NODE_TYPE } from "./task-fields.js";
import { ValidationError } from "../shared/errors.js";

export const BACKFILL_MAX = 100;

export interface BackfillRow {
  id: string;
  ticket?: string;
  outcome: "numbered" | "skipped" | "failed";
  reason?: string;
}

export interface BackfillResult {
  /** Tasks still without a number after this call. */
  remaining: number;
  numbered: number;
  failed: number;
  results: BackfillRow[];
}

export async function backfillTicketNumbers(
  nestId: string,
  userEmail: string,
  opts: { limit?: number; dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const rules = await nestTaskRules(nestId);
  if (!rules.ticket_numbering) {
    throw new ValidationError(
      "Turn on ticket numbering (task_rules.ticket_numbering) before numbering existing tasks.",
    );
  }
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? BACKFILL_MAX)), BACKFILL_MAX);
  // Never hand out a number a task already holds (imported tickets, ticket_start_at).
  if (!opts.dryRun) {
    await storeDefaultTaskRules(nestId);
    await syncTicketCounters(nestId, rules);
  }

  await ensureNodeIndex(nestId);
  const tasks = (await readIndexedNodes(nestId))
    .filter((n) => n.frontmatter.type === TASK_NODE_TYPE)
    .filter((n) => !ticketTagOf((n.frontmatter.tags || []) as string[]))
    .sort((a, b) => {
      const ca = String(a.frontmatter.created_at ?? "");
      const cb = String(b.frontmatter.created_at ?? "");
      return ca < cb ? -1 : ca > cb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const results: BackfillRow[] = [];
  let numbered = 0;
  let failed = 0;
  for (const node of tasks.slice(0, limit)) {
    const tags = (node.frontmatter.tags || []) as string[];
    const prefix = ticketPrefixOf(rules);
    if (!prefix) {
      results.push({ id: node.id, outcome: "skipped", reason: "the nest has no ticket prefix" });
      continue;
    }
    if (opts.dryRun) {
      results.push({ id: node.id, outcome: "skipped", reason: `would get a ${prefix}- number` });
      continue;
    }
    try {
      const ticket = await allocateTicket(nestId, prefix);
      await updateNode(
        nestId,
        node.id,
        { tags: [...tags, ticketTag(ticket)], changeNote: `Assigned ticket ${ticket}` },
        userEmail,
        { assignTicket: true, publishOnly: true },
      );
      numbered++;
      results.push({ id: node.id, ticket, outcome: "numbered" });
    } catch (err) {
      failed++;
      results.push({ id: node.id, outcome: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const attempted = opts.dryRun ? 0 : numbered;
  const unnumberable = results.filter((r) => r.outcome === "skipped" && !opts.dryRun).length;
  return {
    remaining: Math.max(0, tasks.length - attempted - unnumberable),
    numbered,
    failed,
    results,
  };
}
