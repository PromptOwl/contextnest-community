/**
 * The Channels page's rules as plain functions (PO-1189): where a visitor
 * lands, when the open channel needs a refresh, how new messages fold into
 * the timeline on screen, and the small labels around them. DOM-free and
 * state-free so each rule is tested on values; `useChannels` wires them to
 * the server.
 */
import type {
  ChannelList,
  ChannelMessage,
  ChannelNewMessage,
  ChannelPost,
  ChannelSummary,
  ChannelTimeline,
  PostedMention,
} from "./api";

/** How often the channel list is re-read while the tab is visible. */
export const CHANNEL_POLL_MS = 12_000;
/** The list's refresh interval given how the last read ended: the usual pace,
 *  or no polling once the server has said the caller has no channels here. */
export function channelPollInterval(lastErrorStatus: number | undefined): number | false {
  return lastErrorStatus === 403 || lastErrorStatus === 404 ? false : CHANNEL_POLL_MS;
}
/** Posts per timeline page ("Load more" asks for the next one). */
export const TIMELINE_PAGE = 50;
/** The most one timeline read may ask for. */
export const TIMELINE_MAX = 200;

/** What the page holds for the open channel. */
export interface TimelineState {
  channel: ChannelSummary;
  /** Latest activity first. */
  posts: ChannelPost[];
  total: number;
  has_more: boolean;
  /** Opaque cursor for the next "what is new" read. */
  next_since: string | null;
}

export function toTimelineState(t: ChannelTimeline): TimelineState {
  return {
    channel: t.channel,
    posts: t.posts,
    total: t.pagination.total,
    has_more: t.pagination.has_more,
    next_since: t.next_since ?? null,
  };
}

export function splitChannels(channels: ChannelSummary[]): { live: ChannelSummary[]; archived: ChannelSummary[] } {
  return { live: channels.filter((c) => !c.archived), archived: channels.filter((c) => c.archived) };
}

/**
 * The channel to show. A channel named in the URL is kept as is, listed or
 * not: an archived one still reads, and an unknown one gets the server's
 * answer rather than a silent swap. With none named, the most recently active
 * one, then the first.
 */
export function initialChannel(requested: string | null | undefined, list: ChannelList): string | null {
  if (requested) return requested;
  const { live } = splitChannels(list.channels);
  if (list.most_recent && live.some((c) => c.name === list.most_recent)) return list.most_recent;
  return live[0]?.name ?? null;
}

/** Has the channel had a message since the copy on screen was read? Stored
 *  times share one format, so they compare as text. */
export function hasNewActivity(
  row: Pick<ChannelSummary, "last_activity_at">,
  held: Pick<ChannelSummary, "last_activity_at">,
): boolean {
  return (row.last_activity_at ?? "") > (held.last_activity_at ?? "");
}

/**
 * The timeline with messages from a "what is new" read folded in: a new post
 * goes to the top; a reply bumps its post's count and activity time and moves
 * it to the top. A message the timeline already reflects is skipped, so a
 * full re-read that raced this one cannot count a reply twice. `missing` says
 * a reply belonged to a post that is not loaded: the caller re-reads.
 */
export function applyNewMessages(
  posts: ChannelPost[],
  messages: ChannelNewMessage[],
): { posts: ChannelPost[]; added: number; missing: boolean } {
  let next = posts;
  let added = 0;
  let missing = false;
  for (const m of messages) {
    const at = next.findIndex((p) => p.id === m.thread_id);
    if (!m.reply) {
      if (at !== -1) continue;
      const { thread_id, reply: _reply, ...message } = m;
      next = [
        { ...message, id: thread_id, status: "open", reply_count: 0, last_reply_at: null, last_activity_at: m.created_at, promoted: [] },
        ...next,
      ];
      added += 1;
      continue;
    }
    if (at === -1) {
      missing = true;
      continue;
    }
    const post = next[at];
    if (m.created_at <= (post.last_activity_at ?? post.last_reply_at ?? post.created_at)) continue;
    const bumped: ChannelPost = {
      ...post,
      reply_count: post.reply_count + 1,
      last_reply_at: m.created_at,
      last_activity_at: m.created_at,
    };
    next = [bumped, ...next.slice(0, at), ...next.slice(at + 1)];
    added += 1;
  }
  return { posts: next, added, missing };
}

/** The open thread's replies with the new ones for that thread added, once each. */
export function appendReplies(replies: ChannelMessage[], messages: ChannelNewMessage[], threadId: string): ChannelMessage[] {
  const seen = new Set(replies.map((r) => r.id));
  const fresh = messages.filter((m) => m.reply && m.thread_id === threadId && !seen.has(m.id));
  return fresh.length ? [...replies, ...fresh] : replies;
}

/** "Load more": the next page after what is shown. Activity reorders the
 *  timeline between reads, so a post already on screen is dropped. */
export function appendPage(posts: ChannelPost[], page: ChannelPost[]): ChannelPost[] {
  const seen = new Set(posts.map((p) => p.id));
  return [...posts, ...page.filter((p) => !seen.has(p.id))];
}

/** Who wrote a message: the agent when one was declared (with the person it
 *  acts for), otherwise the person, by display name. */
export function authorOf(m: Pick<ChannelMessage, "actor" | "author" | "author_name">): {
  name: string;
  onBehalfOf: string | null;
  agent: boolean;
} {
  const human = m.actor?.human || m.author_name || m.author;
  return m.actor?.agent
    ? { name: m.actor.agent, onBehalfOf: human, agent: true }
    : { name: human, onBehalfOf: null, agent: false };
}

export function replyLabel(count: number): string {
  if (count <= 0) return "Reply";
  return count === 1 ? "1 reply" : `${count} replies`;
}

/** The number beside a channel: unread messages, nothing when there are none. */
export function unreadLabel(unread: number): string | null {
  if (!unread || unread <= 0) return null;
  return unread > 99 ? "99+" : String(unread);
}

/**
 * The title the promote dialog starts with: the post's first line without
 * mentions or markdown, at most 80 characters (the server derives the same
 * when none is sent).
 */
export function promoteTitle(body: string): string {
  const line = (body || "").split("\n").find((l) => l.trim()) ?? "";
  const plain = line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/(^|\s)@(?:\([^)]*\)|[a-zA-Z0-9._@-]+)/g, "$1")
    .replace(/\[\[(?:[^\]|]*\/)?([^\]|/]+)(?:\|[^\]]*)?\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length <= 80 ? plain : plain.slice(0, 80).trim();
}

const list = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * One line for the toast after posting, or null when every mention landed.
 * Only two outcomes are worth interrupting for: a name that matched nobody,
 * and an agent with no wake-up webhook. `wake: "skipped"` is normal (an
 * agent's own message, a rate limit), and an empty list is what a caller who
 * can't see the roster gets, so neither says anything.
 */
export function mentionNotice(outcomes: PostedMention[] | undefined): string | null {
  if (!outcomes?.length) return null;
  const uniq = (names: string[]) => {
    const seen = new Set<string>();
    return names.filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
  };
  const nobody = uniq(outcomes.filter((o) => o.kind === "nobody").map((o) => `@${o.name}`));
  const asleep = uniq(outcomes.filter((o) => o.kind === "agent" && o.wake === "no_webhook").map((o) => `@${o.name}`));
  const parts: string[] = [];
  if (nobody.length) parts.push(`${list(nobody)} matched nobody in this nest.`);
  if (asleep.length)
    parts.push(
      `${list(asleep)} ${asleep.length === 1 ? "has" : "have"} no wake-up webhook. ${
        asleep.length === 1 ? "It" : "They"
      } will see this when ${asleep.length === 1 ? "it next checks its" : "they next check their"} work.`,
    );
  return parts.length ? parts.join(" ") : null;
}
