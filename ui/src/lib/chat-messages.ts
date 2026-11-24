/**
 * What a person can do to one message (PO-1200, AC-C3-12, from the C1
 * contract PO-1196): react, edit, delete, pin, save, link — as plain rules,
 * so the page asks one function and the rules are tested on values.
 */
import type { ChannelMessage, ChannelPost, MessageReaction, PostedMention } from "./api";

/** The reactions offered first; any other emoji goes through the picker's box. */
export const QUICK_EMOJI = ["👍", "✅", "👀", "🎉", "❤️", "🚀"] as const;

/** Which call a tap on a reaction makes: mine comes off, anyone else's goes on. */
export function reactionToggle(reactions: readonly MessageReaction[] | undefined, emoji: string): "add" | "remove" {
  return reactions?.some((r) => r.emoji === emoji && r.me) ? "remove" : "add";
}

/** "Rita Reader and 2 more" — the tooltip under a reaction chip. */
export function reactionTitle(r: Pick<MessageReaction, "emoji" | "count" | "by">): string {
  const more = r.count - r.by.length;
  const names = r.by.length ? r.by.join(", ") : `${r.count}`;
  return more > 0 ? `${names} and ${more} more reacted with ${r.emoji}` : `${names} reacted with ${r.emoji}`;
}

/**
 * May the reader edit this message? Author only, by login, and never a
 * tombstone. (In the browser nobody declares an agent, so a person edits
 * anything under their login, their agents' messages included — the server's
 * rule.)
 */
export function canEdit(m: Pick<ChannelMessage, "author" | "deleted">, me: string | null | undefined): boolean {
  if (!me || m.deleted) return false;
  return m.author.toLowerCase() === me.toLowerCase();
}

/** May the reader delete it? Their own, or anyone's as the nest's owner or admin. */
export function canDelete(m: Pick<ChannelMessage, "author" | "deleted">, me: string | null | undefined, permission: string | null | undefined): boolean {
  if (m.deleted) return false;
  if (permission === "owner" || permission === "admin") return true;
  return canEdit(m, me);
}

/** The tombstone's one line. */
export function tombstoneLine(m: Pick<ChannelMessage, "deleted_by">): string {
  return m.deleted_by === "moderator" ? "This message was removed by a moderator." : "This message was deleted.";
}

/** Replace one message's fields in a list, by id — the post keeps its thread fields. */
export function patchMessage<M extends { id: string }>(list: readonly M[], id: string, patch: Partial<M>): M[] {
  return list.map((m) => (m.id === id ? { ...m, ...patch } : m));
}

/** The id the message routes take: a reply's own, a post's opening message. */
export function messageIdOf(m: ChannelMessage | ChannelPost): string {
  return (m as ChannelPost).message_id ?? m.id;
}

/**
 * Highlight ranges of a search excerpt as non-overlapping pieces, in order:
 * the server's ranges can overlap when terms repeat, so they are merged.
 */
export function excerptPieces(excerpt: string, highlights: readonly { start: number; end: number }[]): Array<{ text: string; hit: boolean }> {
  const sorted = [...highlights].filter((h) => h.end > h.start).sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const h of sorted) {
    const last = merged[merged.length - 1];
    if (last && h.start <= last.end) last.end = Math.max(last.end, h.end);
    else merged.push({ start: Math.max(0, h.start), end: Math.min(excerpt.length, h.end) });
  }
  const out: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const h of merged) {
    if (h.start > at) out.push({ text: excerpt.slice(at, h.start), hit: false });
    if (h.end > h.start) out.push({ text: excerpt.slice(h.start, h.end), hit: true });
    at = Math.max(at, h.end);
  }
  if (at < excerpt.length) out.push({ text: excerpt.slice(at), hit: false });
  return out;
}

/** "Reached 4 people" after a @channel or @here, or null. */
export function broadcastNotice(outcomes: readonly PostedMention[] | undefined): string | null {
  const all = (outcomes ?? []).filter((o): o is Extract<PostedMention, { kind: "everyone" }> => o.kind === "everyone");
  if (!all.length) return null;
  const n = Math.max(...all.map((o) => o.reached));
  return n === 1 ? "Reached 1 person" : `Reached ${n} people`;
}

/** The search box's second job: a query of two or more characters. */
export function searchable(q: string): boolean {
  return q.trim().length >= 2;
}
