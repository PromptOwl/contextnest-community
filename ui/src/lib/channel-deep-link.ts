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
  // "#ops" and "ops" name the same channel; the page works with the bare name.
  const channel = (p.get("channel") || "").trim().toLowerCase().replace(/^#+/, "");
  const thread = (p.get("thread") || "").trim();
  return { channel: channel || null, thread: channel && thread ? thread : null };
}

/**
 * The channel and open thread as URL params (PO-1189), so a reload, Back and
 * Forward, and a copied link restore the same view. A thread only means
 * something inside a channel, so it is dropped without one.
 */
export function writeChannelParams(
  params: URLSearchParams,
  loc: { channel?: string | null; thread?: string | null },
): void {
  if (loc.channel) params.set("channel", loc.channel);
  else params.delete("channel");
  if (loc.channel && loc.thread) params.set("thread", loc.thread);
  else params.delete("thread");
}

/** What the Channels view is looking at, for history: each channel and each
 *  open thread earns its own Back stop. Null before a channel is selected. */
export function channelHistoryKey(
  nestId: string,
  channel: string | null | undefined,
  thread: string | null | undefined,
): string | null {
  return channel ? `${nestId}/#${channel}/${thread ?? ""}` : null;
}
