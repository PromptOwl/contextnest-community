/**
 * My Work over MCP (PO-1180; S4b PO-1190) — `context_my_work`, the twin of
 * GET /me/work. It calls the same `buildMyWork` the REST route calls and
 * returns that object as structuredContent, so the sections and items cannot
 * drift (AC-MW-05): the open threads that @mention you, reviews and requests
 * waiting on you, what you handed off, assigned cards, unread notifications.
 *
 * For an agent (AC-AX-01): a call made with a key whose label is an agent's
 * handle, or that declares `client.agent`, also lists the threads that tag
 * THAT handle (`for_agent`), so an agent with no webhook still finds what is
 * waiting on it. The label only widens which handles match; every row is
 * still limited to what the person behind the key can open.
 *
 * Small by default (AC-AX-02): mentions first, and the unread-notification
 * list only when asked for (`sections`), because it is the person's inbox,
 * not the agent's queue. `sections` and `limit` trim it further.
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
import { MY_WORK_SECTIONS, buildMyWork, parseMyWorkPaging, parseMyWorkSections, type MyWork, type MyWorkSection } from "../me/my-work.js";
import { actingAgentHandle } from "../mentions/mention-index.js";
import { ValidationError } from "../shared/errors.js";
import { toolError, type McpToolContext, type ToolResult } from "./tools.js";

/** What a call gets when it names no sections: everything but the person's
 *  unread-notification list. */
const DEFAULT_SECTIONS: MyWorkSection[] = ["mentions", "items", "assigned", "waiting"];
/** The sections the totals are built from. */
const CORE_SECTIONS: MyWorkSection[] = ["mentions", "items", "assigned", "waiting", "notifications"];

export const MY_WORK_TOOL_DEFINITIONS = [
  {
    name: "context_my_work",
    description:
      "Lists what is waiting on you across the nests you can read — your work queue, mentions first: " +
      "`mentions` (open threads, in channels and on documents, that @mention you — or the agent this key or `client.agent` names, marked `for_agent` — and that haven't been answered: " +
      "reply in the thread with context_comment { thread, body }, resolve it, or clear it with context_resolve_comment { thread, mention_done: true }), " +
      "`items` (reviews, deletion and access requests you can decide), `assigned` (open cards assigned to you) and `waiting` (what you handed off). " +
      "`notifications` (the person's unread inbox) and `saved` (channel messages you saved for later, with the channels switch on) are returned only when asked for in `sections`. " +
      "`sections` picks what comes back; `limit` caps every section. A nest-scoped key sees only this nest.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sections: {
          type: "array",
          items: { type: "string" },
          description: `Which sections to return: any of ${MY_WORK_SECTIONS.join(", ")}. Default: all but notifications.`,
        },
        limit: { type: "number", description: "Rows per section (max 100). Default: 50 reviews and 50 mentions, the other sections whole." },
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

export function myWorkText(w: MyWork, actingAs: string | null = null): string {
  const out: string[] = [actingAs ? `# My Work (yours, and @${actingAs}'s mentions)` : "# My Work"];
  if (w.mentions && w.mentions_pagination) {
    const mp = w.mentions_pagination;
    out.push(
      `\n## Mentions (${mp.total} open${mp.total > w.mentions.length ? `, showing ${mp.offset + 1}–${mp.offset + w.mentions.length}` : ""})`,
    );
    if (w.mentions.length === 0) out.push("Nothing is waiting on your reply.");
    for (const m of w.mentions) {
      const where = m.channel ? `#${m.channel}` : `"${m.title}"`;
      const who = m.for_agent ? ` (for @${m.for_agent})` : "";
      out.push(
        `- ${m.author_label} in ${where} · ${m.nest_name}${who} — ${line(m.excerpt)}\n  thread: ${m.thread_id} · node: ${m.node_id} · ${m.mentioned_at}`,
      );
    }
    if (w.mentions.length) {
      out.push("Reply with context_comment { thread, body }; clear one without replying with context_resolve_comment { thread, mention_done: true }.");
    }
  }
  if (w.items) {
    out.push(`\n## Waiting on you (${w.items.length})`);
    for (const i of w.items) out.push(`- ${i.type}: "${i.title}" · ${i.nest_name} — from ${i.requested_by}`);
  }
  if (w.assigned) {
    out.push(`\n## Assigned to you (${w.assigned.length})`);
    for (const a of w.assigned) out.push(`- "${a.title}" · ${a.nest_name}${a.due ? ` · due ${a.due}` : ""}`);
  }
  if (w.waiting) {
    out.push(`\n## You're waiting on (${w.waiting.length})`);
    for (const i of w.waiting) out.push(`- ${i.type}: "${i.title}" · ${i.nest_name}`);
  }
  if (w.notifications) {
    out.push(`\n## Unread notifications (${w.notifications.length})`);
    for (const n of w.notifications) out.push(`- ${line(String(n.message ?? ""))}`);
  }
  if (w.saved) {
    out.push(`\n## Saved messages (${w.saved_pagination?.total ?? w.saved.length})`);
    if (w.saved.length === 0) out.push("Nothing saved. Save one with context_message { action: \"save\", message }.");
    for (const s of w.saved) {
      out.push(`- ${s.message.actor.label} in #${s.channel} · ${s.nest_name} — ${line(s.message.body)}\n  thread: ${s.thread_id} · message: ${s.message.id} · ${s.message.url}`);
    }
  }
  if (w.waiting_on_me_total !== undefined) {
    out.push(`\n**Waiting on you in total:** ${w.waiting_on_me_total}${w.assigned ? ` (plus ${w.assigned.length} assigned)` : ""}.`);
  }
  return out.join("\n");
}

export async function runMyWorkTool(
  _toolName: string,
  args: Record<string, any>,
  ctx: McpToolContext,
): Promise<ToolResult> {
  let sections: MyWorkSection[];
  try {
    sections = parseMyWorkSections(args?.sections) ?? DEFAULT_SECTIONS;
  } catch (err) {
    if (err instanceof ValidationError) return toolError(err.message, "VALIDATION_FAILED");
    throw err;
  }
  const paging = parseMyWorkPaging(args ?? {});
  const actingAs = actingAgentHandle(ctx.client);
  // Every counted section asked for (the REST default set) → the full object,
  // totals included, exactly as GET /me/work returns it (`saved` rides on it
  // while channels are on; it is not part of any total).
  const all = CORE_SECTIONS.every((s) => sections.includes(s));
  const data = await buildMyWork({
    userId: ctx.userId,
    ...paging,
    onlyNestId: ctx.crossNest === true ? null : ctx.nestId,
    sections: all ? null : sections,
    actingAs,
  });
  return { text: myWorkText(data, actingAs), data };
}
