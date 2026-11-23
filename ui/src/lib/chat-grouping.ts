/**
 * How a conversation reads (PO-1200, AC-C3-03): messages oldest first, the
 * ones from one author within five minutes under one header, a date line
 * where the day changes, and one "New" line before what was unread when the
 * channel was opened. Pure: the page hands in messages and gets back the
 * rows to draw, so every rule here is tested on values.
 */
import type { ChannelMessage } from "./api";
import { parseServerDate } from "./dates";

/** Messages from one author this close together share a header. */
export const GROUP_WINDOW_MS = 5 * 60_000;

export type ConversationRow<M> =
  | { kind: "date"; key: string; label: string }
  | { kind: "new"; key: "new" }
  | {
      kind: "message";
      key: string;
      message: M;
      /** Heads its group: avatar, name and time are drawn. */
      first: boolean;
      /** Closes its group (the next row is a line or another author). */
      last: boolean;
    };

type Timed = { id: string; created_at: string };

/** Oldest first; ties keep their order, so a re-sort never reshuffles. */
export function sortChronological<M extends Timed>(list: readonly M[]): M[] {
  return list
    .map((m, i) => ({ m, i, t: parseServerDate(m.created_at)?.getTime() ?? 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** "Today", "Yesterday", then the weekday and date; the year only when it is
 *  not this one. */
export function dateLabel(d: Date, now: Date = new Date()): string {
  const days = Math.round((dayStart(now).getTime() - dayStart(d).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "10:42" — the time inside a day; the date line already says which day. */
export function timeLabel(raw: string): string {
  const d = parseServerDate(raw);
  return d ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
}

/** Who a message is from, for grouping: the person, and the agent if one
 *  wrote it for them (an agent's reply never joins the person's group). */
export function groupKey(m: Pick<ChannelMessage, "author" | "actor">): string {
  return `${(m.author || "").toLowerCase()}|${m.actor?.agent ?? ""}`;
}

/** Does `next` continue `prev`'s group? Same author (and agent), same day,
 *  within the window. */
export function continuesGroup(
  prev: Pick<ChannelMessage, "author" | "actor" | "created_at">,
  next: Pick<ChannelMessage, "author" | "actor" | "created_at">,
): boolean {
  if (groupKey(prev) !== groupKey(next)) return false;
  const a = parseServerDate(prev.created_at);
  const b = parseServerDate(next.created_at);
  if (!a || !b) return false;
  return sameDay(a, b) && b.getTime() - a.getTime() <= GROUP_WINDOW_MS && b.getTime() >= a.getTime();
}

/**
 * The message the "New" line goes before: the earliest of the last `unread`
 * messages by other people, as the server counted them when the channel was
 * opened. Null when nothing was unread or nothing here is by someone else.
 * (The count includes replies, which the list does not show, so the line can
 * sit a little early — never late. A `last_read_at` on the channel row would
 * make it exact; see .notes/server-gaps.md.)
 */
export function newLineAnchor<M extends Pick<ChannelMessage, "id" | "author">>(
  chronological: readonly M[],
  unread: number,
  me: string | null | undefined,
): string | null {
  if (!unread || unread <= 0) return null;
  const mine = (me ?? "").toLowerCase();
  let seen = 0;
  let anchor: string | null = null;
  for (let i = chronological.length - 1; i >= 0; i--) {
    const m = chronological[i];
    if ((m.author || "").toLowerCase() === mine) continue;
    anchor = m.id;
    seen += 1;
    if (seen >= unread) break;
  }
  return anchor;
}

/**
 * The rows of a conversation: date lines, the "New" line, and messages with
 * their group position. `messages` may come in any order.
 */
export function buildConversation<M extends ChannelMessage>(
  messages: readonly M[],
  opts: { now?: Date; newBefore?: string | null } = {},
): ConversationRow<M>[] {
  const now = opts.now ?? new Date();
  const sorted = sortChronological(messages);
  const rows: ConversationRow<M>[] = [];
  let prev: M | null = null;
  let prevDay: Date | null = null;
  sorted.forEach((m, i) => {
    const at = parseServerDate(m.created_at);
    let broke = false;
    if (at && (!prevDay || !sameDay(prevDay, at))) {
      rows.push({ kind: "date", key: `date:${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`, label: dateLabel(at, now) });
      prevDay = at;
      broke = true;
    }
    if (opts.newBefore && m.id === opts.newBefore) {
      rows.push({ kind: "new", key: "new" });
      broke = true;
    }
    const first = broke || !prev || !continuesGroup(prev, m);
    const next = sorted[i + 1];
    const last = !next || !continuesGroup(m, next) || (opts.newBefore != null && next.id === opts.newBefore) || !!(at && parseServerDate(next.created_at) && !sameDay(at, parseServerDate(next.created_at)!));
    rows.push({ kind: "message", key: `m:${m.id}`, message: m, first, last });
    prev = m;
  });
  return rows;
}

/** "3 replies · 2m ago" under a post; null without replies. */
export function threadSummary(post: { reply_count: number }, lastReplyRel: string | null): string | null {
  if (post.reply_count <= 0) return null;
  const n = post.reply_count === 1 ? "1 reply" : `${post.reply_count} replies`;
  return lastReplyRel ? `${n} · ${lastReplyRel}` : n;
}
