/**
 * The harness sidebar's rules (PO-1200, AC-C3-02) and the context rail's
 * (AC-C3-05), as plain functions: how channels order and filter, which of my
 * mentions belong to this nest, and which nodes a thread touches.
 */
import type { ArtifactCard, ChannelMessage, ChannelPost, ChannelSummary, MentionItem } from "./api";

/** Newest activity first; an empty channel after the rest; ties by name. */
export function orderByActivity<C extends Pick<ChannelSummary, "name" | "last_activity_at">>(channels: readonly C[]): C[] {
  return [...channels].sort((a, b) => {
    const ta = a.last_activity_at ?? "";
    const tb = b.last_activity_at ?? "";
    if (ta !== tb) return ta > tb ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** The channels whose name or purpose contains every word typed. */
export function filterChannels<C extends Pick<ChannelSummary, "name" | "purpose">>(channels: readonly C[], query: string): C[] {
  const words = query.toLowerCase().replace(/^#+/, "").split(/\s+/).filter(Boolean);
  if (!words.length) return [...channels];
  return channels.filter((c) => {
    const hay = `${c.name} ${c.purpose ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** My open mentions in this nest, newest first (the server's order). */
export function mentionsForNest(mentions: readonly MentionItem[] | undefined, nestId: string): MentionItem[] {
  return (mentions ?? []).filter((m) => m.nest_id === nestId);
}

/** Unread across the channels not on screen, for the phone's top bar. */
export function unreadElsewhere(channels: readonly Pick<ChannelSummary, "name" | "unread">[], selected: string | null): number {
  return channels.reduce((n, c) => (c.name === selected ? n : n + Math.max(0, c.unread)), 0);
}

export interface ContextNode {
  id: string;
  title: string;
  /** How the thread touches it: linked from a message, or made from the thread. */
  via: "link" | "decision" | "task";
}

/** A card the reader may open, in this nest; an unresolved link or a node of
 *  another nest is not something the rail can open here. */
const cardNode = (c: ArtifactCard, nestId: string | null): ContextNode | null => {
  if (!c.resolved || c.kind !== "node") return null;
  if (nestId && c.nest_id !== nestId) return null;
  return { id: c.node_id, title: c.title || c.node_id, via: "link" };
};

/** The nodes a thread touches: what its messages link, then what it was
 *  promoted to. Each once, in first-seen order; a promoted node outranks a
 *  mere link to the same node. */
export function threadNodes(
  post: ChannelPost | null | undefined,
  replies: readonly ChannelMessage[] = [],
  nestId: string | null = null,
): ContextNode[] {
  const out = new Map<string, ContextNode>();
  for (const n of post?.promoted ?? []) out.set(n.node_id, { id: n.node_id, title: n.title, via: n.kind });
  const messages = post ? [post, ...replies] : replies;
  for (const m of messages) {
    for (const c of m.cards ?? []) {
      const n = cardNode(c, nestId);
      if (n && !out.has(n.id)) out.set(n.id, n);
    }
  }
  return [...out.values()];
}

/** The chat's address: the page, its channel, and the open thread. */
export function chatHref(nestId: string, channel: string | null, thread?: string | null, message?: string | null): string {
  const base = `/nest/${encodeURIComponent(nestId)}/chat`;
  const q = new URLSearchParams();
  if (channel) q.set("channel", channel);
  if (channel && thread) q.set("thread", thread);
  if (channel && thread && message) q.set("message", message);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}
