/**
 * Recommendation rules (PO-1201, team chat C10): which agent would help this
 * nest, decided from rows that already exist — never from a model call.
 *
 * Every rule here is a PURE function of the rows it is handed and `now`, so
 * each has a unit test of its own (AC-C10-08). recommend.ts gathers the rows
 * (only what the caller can read) and runs the rules; this module never
 * touches the database.
 *
 * A recommendation's `id` is stable for as long as its cause holds
 * (`mention:<handle>`, `watcher:<channel>`, …), so a person can dismiss it
 * once (stream_marks, kind 'recommendation') and not see it again until the
 * cause changes.
 */

export type HireKind = "hootie" | "watcher" | "webhook" | "key";

/** The body POST /nests/:id/hire takes — a recommendation carries one ready to send. */
export interface HirePayload {
  kind: HireKind;
  handle?: string;
  config?: Record<string, unknown>;
  channels?: string[];
}

export interface Evidence {
  label: string;
  /** An in-app address; the server still decides whether the caller may open it. */
  link: string;
}

export interface Recommendation {
  id: string;
  action: "hire" | "fix" | "let_go";
  kind: HireKind;
  handle_suggestion: string | null;
  title: string;
  reason: string;
  evidence: Evidence[];
  /** The channels this recommendation points at (for the list badge). */
  channels: string[];
  /** Ready for POST /hire; null for a nudge (`fix`, `let_go`). */
  hire: HirePayload | null;
  /** For `let_go`: what DELETE /hire/:kind/:handle takes. */
  let_go: { kind: HireKind; handle: string } | null;
  dismissible: true;
}

/** A question nobody answered for this long is a question for Hootie. */
export const QUESTION_SILENCE_MS = 24 * 60 * 60_000;
/** Promotes counted inside this window. */
export const PROMOTE_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const PROMOTE_MIN = 3;
export const MENTION_MIN = 3;
/** A key agent that has not been used for this long is asked about. */
export const KEY_IDLE_MS = 30 * 24 * 60 * 60_000;
/** Deliveries looked at for "failing". */
export const FAILING_WINDOW = 3;
export const MAX_RECOMMENDATIONS = 5;
/** Evidence rows per recommendation. */
export const MAX_EVIDENCE = 3;

/** Parse the timestamps this server writes: ISO 8601, or SQLite's
 *  "YYYY-MM-DD HH:MM:SS[.mmm]" (UTC, no zone). NaN for anything else. */
export function toMs(s: string | null | undefined): number {
  if (!s) return NaN;
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(t)) return Date.parse(`${t.replace(" ", "T")}Z`);
  return Date.parse(t);
}

/** A question mark outside a code span. */
export function isQuestion(body: string): boolean {
  if (!body) return false;
  return /\?/.test(body.replace(/`[^`\n]*`/g, ""));
}

const channelThreadLink = (nestId: string, channel: string, threadId: string) =>
  `/nest/${nestId}/channels?${new URLSearchParams({ channel, thread: threadId }).toString()}`;
const docLink = (nestId: string, nodeId: string) => `/nest/${nestId}?doc=${encodeURIComponent(nodeId)}`;
const webhooksLink = (nestId: string) => `/nest/${nestId}/settings/agent-webhooks`;

const excerpt = (body: string, max = 80): string => {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const uniq = (xs: string[]) => [...new Set(xs)];

// ─── Rule 1: questions nobody answered → Hootie ──────────────────────────

export interface QuestionThread {
  thread_id: string;
  channel: string;
  /** The opening message. */
  body: string;
  created_at: string;
  /** Messages after the opening one. */
  replies: number;
  status: string;
}

export function ruleUnansweredQuestions(
  threads: QuestionThread[],
  opts: { now: number; nestId: string; hootieHired: boolean },
): Recommendation | null {
  if (opts.hootieHired) return null;
  const open = threads.filter(
    (t) => t.status === "open" && t.replies === 0 && isQuestion(t.body) && opts.now - toMs(t.created_at) >= QUESTION_SILENCE_MS,
  );
  if (open.length === 0) return null;
  return {
    id: "hootie:unanswered",
    action: "hire",
    kind: "hootie",
    handle_suggestion: "hootie",
    title: "Hire Hootie to answer questions from the nest",
    reason: `${plural(open.length, "question")} in ${uniq(open.map((t) => `#${t.channel}`)).join(", ")} got no reply for a day. Hootie answers from what the nest knows, with citations.`,
    evidence: open.slice(0, MAX_EVIDENCE).map((t) => ({ label: excerpt(t.body), link: channelThreadLink(opts.nestId, t.channel, t.thread_id) })),
    channels: uniq(open.map((t) => t.channel)),
    hire: { kind: "hootie" },
    let_go: null,
    dismissible: true,
  };
}

// ─── Rule 2: a channel that keeps producing records → a watcher ──────────

export interface PromoteRow {
  channel: string;
  at: string;
  node_id: string;
  title: string;
}

export function rulePromoteHotspots(
  promotes: PromoteRow[],
  opts: { now: number; nestId: string; watched: (channel: string) => boolean },
): Recommendation[] {
  const byChannel = new Map<string, PromoteRow[]>();
  for (const p of promotes) {
    if (opts.now - toMs(p.at) > PROMOTE_WINDOW_MS) continue;
    byChannel.set(p.channel, [...(byChannel.get(p.channel) ?? []), p]);
  }
  const out: Recommendation[] = [];
  for (const [channel, rows] of [...byChannel.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (rows.length < PROMOTE_MIN || opts.watched(channel)) continue;
    const handle = `${channel}-watcher`;
    out.push({
      id: `watcher:${channel}`,
      action: "hire",
      kind: "watcher",
      handle_suggestion: handle,
      title: `Hire a watcher for #${channel}`,
      reason: `#${channel} turned ${plural(rows.length, "thread")} into decisions or tasks this week. A watcher reads the channel and points out what is settled but not yet recorded.`,
      evidence: rows.slice(0, MAX_EVIDENCE).map((p) => ({ label: p.title, link: docLink(opts.nestId, p.node_id) })),
      channels: [channel],
      hire: { kind: "watcher", handle, channels: [channel] },
      let_go: null,
      dismissible: true,
    });
  }
  return out;
}

// ─── Rule 3: a name people keep tagging that nobody answers to ───────────

export interface MentionRow {
  handle: string;
  channel: string;
  thread_id: string;
  at: string;
}

export function ruleUnmatchedMentions(mentions: MentionRow[], opts: { nestId: string; known: Set<string> }): Recommendation[] {
  const byHandle = new Map<string, MentionRow[]>();
  for (const m of mentions) {
    if (opts.known.has(m.handle)) continue;
    byHandle.set(m.handle, [...(byHandle.get(m.handle) ?? []), m]);
  }
  const out: Recommendation[] = [];
  for (const [handle, rows] of [...byHandle.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (rows.length < MENTION_MIN) continue;
    out.push({
      id: `mention:${handle}`,
      action: "hire",
      kind: "key",
      handle_suggestion: handle,
      title: `Hire @${handle}`,
      reason: `People tagged @${handle} ${rows.length} times and nobody answers to that name. Give it a key (an agent connecting over MCP finds these mentions in its work queue) or, if it has a runner, a webhook.`,
      evidence: rows.slice(0, MAX_EVIDENCE).map((m) => ({ label: `@${handle} in #${m.channel}`, link: channelThreadLink(opts.nestId, m.channel, m.thread_id) })),
      channels: uniq(rows.map((m) => m.channel)),
      hire: { kind: "key", handle },
      let_go: null,
      dismissible: true,
    });
  }
  return out;
}

// ─── Rule 4: a webhook that isn't getting through → fix or replace ────────

export interface WebhookHealth {
  handle: string;
  /** Newest first, at most FAILING_WINDOW entries. */
  recent: Array<"ok" | "failed" | "pending">;
}

export function ruleFailingWebhooks(webhooks: WebhookHealth[], opts: { nestId: string }): Recommendation[] {
  const out: Recommendation[] = [];
  for (const w of webhooks) {
    const recent = w.recent.slice(0, FAILING_WINDOW);
    if (recent.length === 0 || !recent.every((s) => s === "failed")) continue;
    out.push({
      id: `webhook-fix:${w.handle}`,
      action: "fix",
      kind: "webhook",
      handle_suggestion: w.handle,
      title: `@${w.handle} is not getting its wake-ups`,
      reason: `The last ${plural(recent.length, "delivery", "deliveries")} to @${w.handle}'s webhook failed. Send a test event, fix the runner's URL, or replace it.`,
      evidence: [{ label: "Agent webhooks", link: webhooksLink(opts.nestId) }],
      channels: [],
      hire: null,
      let_go: null,
      dismissible: true,
    });
  }
  return out;
}

// ─── Rule 5: a key agent that went quiet → let go? ───────────────────────

export interface KeyRow {
  handle: string;
  created_at: string;
  last_used_at: string | null;
}

export function ruleIdleKeys(keys: KeyRow[], opts: { now: number; nestId: string }): Recommendation[] {
  const out: Recommendation[] = [];
  for (const k of keys) {
    const last = toMs(k.last_used_at ?? k.created_at);
    if (!Number.isFinite(last) || opts.now - last < KEY_IDLE_MS) continue;
    const days = Math.floor((opts.now - last) / (24 * 60 * 60_000));
    out.push({
      id: `key-idle:${k.handle}`,
      action: "let_go",
      kind: "key",
      handle_suggestion: k.handle,
      title: `Let @${k.handle} go?`,
      reason: k.last_used_at
        ? `@${k.handle}'s key has not been used for ${plural(days, "day")}. A key nobody uses is one more to revoke later.`
        : `@${k.handle}'s key was minted ${plural(days, "day")} ago and never used.`,
      evidence: [{ label: `@${k.handle}`, link: `/nest/${opts.nestId}/settings/hire` }],
      channels: [],
      hire: null,
      let_go: { kind: "key", handle: k.handle },
      dismissible: true,
    });
  }
  return out;
}
