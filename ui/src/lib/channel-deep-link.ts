/**
 * Deep links into a channel thread (PO-1180): My Work's Mentions open a
 * channel post at `/nest/<id>/channels?channel=<name>&thread=<post id>`, and
 * the Channels page reads the two params back on mount to select the channel
 * and open the thread. Only an address — the server still decides whether the
 * caller may read it.
 */
import { nestPath } from "./nest-url";

export function channelThreadLink(nestId: string, channel: string, threadId: string): string {
  const q = new URLSearchParams({ channel, thread: threadId });
  return `${nestPath(nestId, "channels")}?${q.toString()}`;
}

export function readChannelDeepLink(search: string): { channel: string | null; thread: string | null } {
  const p = new URLSearchParams(search);
  const channel = (p.get("channel") || "").trim().toLowerCase();
  const thread = (p.get("thread") || "").trim();
  return { channel: channel || null, thread: channel && thread ? thread : null };
}
