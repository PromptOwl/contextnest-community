/**
 * The C2 rules (PO-1200 AC-C3-12, contract PO-1197) as plain functions: how
 * a container (a channel or a conversation) is named in the address and on
 * the server, what each live event means for what is on screen, the typing
 * line, presence, the heartbeat cadence, and the SSE frame parser. The hook
 * (`useChatLive`) wires them to the browser; nothing here touches it.
 */

// ─── Containers ──────────────────────────────────────────────────────────

/** Where messages live: a channel by name, or a conversation by its uuid. */
export type Container = { kind: "channel"; name: string } | { kind: "conversation"; uuid: string };

const CONVERSATION_PREFIX = "~";
const CONVERSATION_NODE = /^nodes\/conversations\/([^/]+)$/;

/** The one string the page passes around for "what is open": a channel's
 *  name, or `~<uuid>` for a conversation (a name can't start with `~`). */
export function containerKey(c: Container): string {
  return c.kind === "channel" ? c.name : `${CONVERSATION_PREFIX}${c.uuid}`;
}

export function parseContainerKey(key: string | null | undefined): Container | null {
  if (!key) return null;
  if (key.startsWith(CONVERSATION_PREFIX)) {
    const uuid = key.slice(1).trim();
    return uuid ? { kind: "conversation", uuid } : null;
  }
  return { kind: "channel", name: key };
}

/** The node id the thread routes take. */
export function containerNodeId(c: Container): string {
  return c.kind === "channel" ? `nodes/channels/${c.name}` : `nodes/conversations/${c.uuid}`;
}

/** A conversation's node id → its key; null for anything else. */
export function keyOfConversationId(nodeId: string): string | null {
  const m = CONVERSATION_NODE.exec(nodeId);
  return m ? `${CONVERSATION_PREFIX}${m[1]}` : null;
}

/** An event's `conversation` (a container node id) → the page's key. */
export function keyOfContainerId(nodeId: string): string | null {
  const conv = keyOfConversationId(nodeId);
  if (conv) return conv;
  const m = /^nodes\/channels\/([^/]+)$/.exec(nodeId);
  return m ? m[1] : null;
}

// ─── Live events ─────────────────────────────────────────────────────────

export type ChatEvent =
  | { event: "hello"; data: { nest_id: string; resume: boolean } }
  | { event: "message.new"; data: { conversation: string; thread_id: string; message_id: string; reply: boolean; author: string; author_name: string; agent: string | null } }
  | { event: "message.changed"; data: { conversation: string; thread_id: string; message_id: string; change?: string } }
  | { event: "read.marked"; data: { conversation: string } }
  | { event: "typing"; data: { conversation: string; who: { email: string; name: string; agent: string | null } } }
  | { event: "presence"; data: { email: string; agent: string | null; status: string | null; active: boolean } }
  | { event: "channel.created" | "channel.archived"; data: { conversation: string; name: string; private?: boolean; archived?: boolean } }
  | { event: "conversation.created"; data: { conversation: string; kind: "dm" | "group"; by: string } }
  | { event: "membership.changed"; data: { conversation: string; action: string; member: string; by: string } }
  | { event: "reset"; data: { reason: string } }
  | { event: string; data: unknown };

/** What the page does about one event. */
export type ChatEffect =
  | { kind: "pull" }
  | { kind: "bump"; key: string }
  | { kind: "zero"; key: string }
  | { kind: "reread"; key: string; thread: string }
  | { kind: "refetch"; what: "channels" | "conversations" | "members" }
  | { kind: "typing"; key: string; who: string }
  | { kind: "presence"; email: string; active: boolean; agent: string | null; status: string | null }
  | { kind: "closed"; key: string }
  | { kind: "reset" }
  | { kind: "none" };

/**
 * One event → what to do, given who I am and what is open. A new message in
 * the open container is pulled with `?since=`; one elsewhere bumps that
 * row's unread unless I wrote it. Edits, reactions and deletes come as
 * `message.changed` and mean a re-read of that thread.
 */
export function chatEffects(e: ChatEvent, ctx: { me: string | null; openKey: string | null }): ChatEffect[] {
  const me = (ctx.me ?? "").toLowerCase();
  switch (e.event) {
    case "message.new": {
      const d = e.data as Extract<ChatEvent, { event: "message.new" }>["data"];
      const key = keyOfContainerId(d.conversation);
      if (!key) return [{ kind: "none" }];
      if (key === ctx.openKey) return [{ kind: "pull" }];
      return d.author.toLowerCase() === me ? [{ kind: "none" }] : [{ kind: "bump", key }];
    }
    case "message.changed": {
      const d = e.data as Extract<ChatEvent, { event: "message.changed" }>["data"];
      const key = keyOfContainerId(d.conversation);
      return key ? [{ kind: "reread", key, thread: d.thread_id }] : [{ kind: "none" }];
    }
    case "read.marked": {
      const key = keyOfContainerId((e.data as { conversation: string }).conversation);
      return key ? [{ kind: "zero", key }] : [{ kind: "none" }];
    }
    case "typing": {
      const d = e.data as Extract<ChatEvent, { event: "typing" }>["data"];
      const key = keyOfContainerId(d.conversation);
      const who = d.who ?? { email: "", name: "", agent: null };
      // An agent types as its handle; a person as their name. Only I myself
      // (not an agent on my key) am left out of the line.
      if (!key || (!who.agent && who.email.toLowerCase() === me)) return [{ kind: "none" }];
      return [{ kind: "typing", key, who: who.agent ? `@${who.agent}` : who.name || who.email }];
    }
    case "presence": {
      const d = e.data as Extract<ChatEvent, { event: "presence" }>["data"];
      return [{ kind: "presence", email: d.email, active: d.active, agent: d.agent, status: d.status }];
    }
    case "channel.created":
    case "channel.archived":
      return [{ kind: "refetch", what: "channels" }];
    case "conversation.created":
      return [{ kind: "refetch", what: "conversations" }];
    case "membership.changed": {
      const d = e.data as Extract<ChatEvent, { event: "membership.changed" }>["data"];
      const key = keyOfContainerId(d.conversation);
      const out: ChatEffect[] = [{ kind: "refetch", what: "members" }];
      if (key && d.action === "left" && d.member.toLowerCase() === me) out.push({ kind: "closed", key });
      if (key && d.action !== "left") out.push({ kind: "refetch", what: key.startsWith(CONVERSATION_PREFIX) ? "conversations" : "channels" });
      return out;
    }
    case "reset":
      return [{ kind: "reset" }];
    default:
      return [{ kind: "none" }];
  }
}

/** The stream's refresh pace: slow while the stream is the fast path,
 *  the usual poll when it is not (polling stays the source of truth). */
export function listPollInterval(streamConnected: boolean, usual: number): number {
  return streamConnected ? Math.max(usual, 60_000) : usual;
}

// ─── SSE frames ──────────────────────────────────────────────────────────

export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

/**
 * Feed raw text in; get complete frames out, plus the leftover to feed next
 * time. A comment line (`: ping`) is reported as a heartbeat, not a frame.
 */
export function parseSse(buffer: string): { frames: SseFrame[]; rest: string; heartbeats: number } {
  const frames: SseFrame[] = [];
  let heartbeats = 0;
  const parts = buffer.replace(/\r\n?/g, "\n").split(/\n\n/);
  const rest = parts.pop() ?? "";
  for (const block of parts) {
    let id: string | null = null;
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) {
        heartbeats += 1;
        continue;
      }
      const at = line.indexOf(":");
      const field = at === -1 ? line : line.slice(0, at);
      const value = at === -1 ? "" : line.slice(at + 1).replace(/^ /, "");
      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) frames.push({ id, event, data: data.join("\n") });
  }
  return { frames, rest, heartbeats };
}

/** Nothing heard for this long: the stream is presumed dead. */
export const STREAM_SILENCE_MS = 45_000;

// ─── Typing and presence ─────────────────────────────────────────────────

/** "Walt is typing…", "Walt and Rita are typing…", "3 people are typing…". */
export function typingLine(names: readonly string[]): string | null {
  const n = [...new Set(names)];
  if (n.length === 0) return null;
  if (n.length === 1) return `${n[0]} is typing…`;
  if (n.length === 2) return `${n[0]} and ${n[1]} are typing…`;
  return `${n.length} people are typing…`;
}

/** Who is still typing: entries older than `ttl` are dropped. */
export function pruneTyping(entries: ReadonlyMap<string, number>, now: number, ttl = 5_000): string[] {
  return [...entries.entries()].filter(([, at]) => now - at < ttl).map(([who]) => who);
}

/** Send a typing signal at most every 3 s. */
export function typingDue(lastSent: number | null, now: number): boolean {
  return lastSent === null || now - lastSent >= 3_000;
}

/** A heartbeat goes out on connect and every 90 s while the tab is visible. */
export function heartbeatDue(last: number | null, now: number, visible: boolean): boolean {
  if (!visible) return false;
  return last === null || now - last >= 90_000;
}

export interface PresenceRow {
  email: string;
  name: string;
  agent: string | null;
  label: string;
  status: string | null;
  last_seen: string;
}

/** The people around now, by lowercased login (agents keep their person's). */
export function onlineSet(active: readonly PresenceRow[]): Set<string> {
  return new Set(active.map((p) => p.email.toLowerCase()));
}

/** Patch the presence list from a `presence` event. */
export function applyPresence(active: readonly PresenceRow[], e: { email: string; agent: string | null; status: string | null; active: boolean }, now: Date = new Date()): PresenceRow[] {
  const rest = active.filter((p) => !(p.email.toLowerCase() === e.email.toLowerCase() && (p.agent ?? null) === (e.agent ?? null)));
  if (!e.active) return rest;
  const prior = active.find((p) => p.email.toLowerCase() === e.email.toLowerCase());
  const name = prior?.name ?? e.email;
  return [...rest, { email: e.email, name, agent: e.agent, label: e.agent ? `${e.agent}, on behalf of ${name}` : name, status: e.status, last_seen: now.toISOString() }];
}

// ─── Notification levels ─────────────────────────────────────────────────

export type { ChatNotifyLevel as NotifyLevel } from "./api";
import type { ChatNotifyLevel as NotifyLevel } from "./api";

export const LEVELS: Array<{ level: NotifyLevel; label: string; detail: string }> = [
  { level: "all", label: "Every message", detail: "Each new message also lands in your bell." },
  { level: "mentions", label: "Mentions only", detail: "Only an @mention pings you. The usual setting." },
  { level: "none", label: "Muted", detail: "No bell, no email. Unread counts still show." },
];

/** The level for a container: its own, else the nest's, else the default. */
export function levelFor(
  prefs: { default: NotifyLevel; nests: Array<{ nest_id: string; level: NotifyLevel; conversations: Array<{ conversation: string; level: NotifyLevel }> }> } | undefined,
  nestId: string,
  containerNodeId: string,
): NotifyLevel {
  if (!prefs) return "mentions";
  const nest = prefs.nests.find((n) => n.nest_id === nestId);
  const own = nest?.conversations.find((c) => c.conversation === containerNodeId);
  return own?.level ?? nest?.level ?? prefs.default ?? "mentions";
}

// ─── App-wide unread ─────────────────────────────────────────────────────

export interface ChatUnreadSummary {
  total: number;
  mentions: number;
  nests: Array<{ nest_id: string; nest_name: string; unread: number; mentions: number; channels: Array<{ id: string; name: string; unread: number }>; conversations: Array<{ id: string; unread: number }> }>;
}

export function unreadForNest(summary: ChatUnreadSummary | undefined, nestId: string): number {
  return summary?.nests.find((n) => n.nest_id === nestId)?.unread ?? 0;
}
