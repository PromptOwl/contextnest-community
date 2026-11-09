/**
 * My Work over MCP (PO-1180, agent team stream S2) — `context_my_work`, the
 * twin of GET /me/work. It calls the same `buildMyWork` the REST route calls
 * and returns that object as structuredContent, so the sections and items
 * cannot drift (AC-MW-05): reviews and requests waiting on you, what you
 * handed off, unread notifications, assigned cards, and the open threads that
 * @mention you (or, once agent principals land, an agent you own).
 *
 * Scope: a credential that is not fenced to one nest (a session, a personal
 * key, an OAuth grant) gets the same cross-nest inbox as REST. A nest-scoped
 * key — which may not call GET /me/work at all (auth/nest-scope-guard.ts) —
 * gets this nest's share of it only.
 *
 * Not behind EXPERIMENTAL_AGENT_STREAM: document-comment mentions, reviews
 * and the rest work without channels.
 *
 * Inline schema: My Work is a Community-only aggregate over this edition's
 * governance tables (reviews, deletion/access requests, inbox rows, board
 * assignments, the mention index); the engine has no such operation to import
 * a descriptor from (scripts/check-mcp-schemas.mjs baseline raised to 101,
 * documented there).
 */
import { buildMyWork, parseMyWorkPaging, type MyWork } from "../me/my-work.js";
import type { McpToolContext, ToolResult } from "./tools.js";

export const MY_WORK_TOOL_DEFINITIONS = [
  {
    name: "context_my_work",
    description:
      "Lists what is waiting on you (or on you as an agent's owner) across the nests you can read — your work queue: " +
      "`mentions` (open comment threads, in channels and on documents, that @mention you and that you haven't answered — reply in the thread with context_comment, or resolve it, and it leaves the list), " +
      "`items` (reviews, deletion and access requests you can decide), `waiting` (what you handed off), `assigned` (open cards assigned to you) and `notifications` (unread). " +
      "Same sections as GET /me/work. A nest-scoped key sees only this nest. Page mentions with mentions_limit / mentions_offset.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Reviews per page (default 50, max 100); also the mentions page size unless mentions_limit is given." },
        offset: { type: "number", description: "Reviews to skip (default 0)." },
        mentions_limit: { type: "number", description: "Mentions per page (default 50, max 100)." },
        mentions_offset: { type: "number", description: "Mentions to skip (default 0)." },
      },
    },
  },
];

const NAMES = new Set(MY_WORK_TOOL_DEFINITIONS.map((t) => t.name));

export function isMyWorkTool(name: string): boolean {
  return NAMES.has(name);
}

function line(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function myWorkText(w: MyWork): string {
  const out: string[] = ["# My Work"];
  const mp = w.mentions_pagination;
  out.push(
    `\n## Mentions (${mp.total} open${mp.total > w.mentions.length ? `, showing ${mp.offset + 1}–${mp.offset + w.mentions.length}` : ""})`,
  );
  if (w.mentions.length === 0) out.push("Nothing is waiting on your reply.");
  for (const m of w.mentions) {
    const where = m.channel ? `#${m.channel}` : `"${m.title}"`;
    const who = m.for_agent ? ` (for your agent @${m.for_agent})` : "";
    out.push(
      `- ${m.author_label} in ${where} · ${m.nest_name}${who} — ${line(m.excerpt)}\n  node: ${m.node_id} · thread: ${m.thread_id} · ${m.mentioned_at}`,
    );
  }
  out.push(`\n## Waiting on you (${w.items.length})`);
  for (const i of w.items) out.push(`- ${i.type}: "${i.title}" · ${i.nest_name} — from ${i.requested_by}`);
  out.push(`\n## Assigned to you (${w.assigned.length})`);
  for (const a of w.assigned) out.push(`- "${a.title}" · ${a.nest_name}${a.due ? ` · due ${a.due}` : ""}`);
  out.push(`\n## You're waiting on (${w.waiting.length})`);
  for (const i of w.waiting) out.push(`- ${i.type}: "${i.title}" · ${i.nest_name}`);
  out.push(`\n## Unread notifications (${w.notifications.length})`);
  for (const n of w.notifications) out.push(`- ${line(String(n.message ?? ""))}`);
  out.push(`\n**Waiting on you in total:** ${w.waiting_on_me_total} (plus ${w.assigned.length} assigned).`);
  return out.join("\n");
}

export async function runMyWorkTool(
  _toolName: string,
  args: Record<string, any>,
  ctx: McpToolContext,
): Promise<ToolResult> {
  const paging = parseMyWorkPaging(args ?? {});
  const data = await buildMyWork({
    userId: ctx.userId,
    ...paging,
    onlyNestId: ctx.crossNest === true ? null : ctx.nestId,
  });
  return { text: myWorkText(data), data };
}
