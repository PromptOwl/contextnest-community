/**
 * Deep links into a channel thread (PO-1180): My Work's Mentions open a
 * channel post at `/nest/<id>/chat?channel=<name>&thread=<post id>`, and the
 * chat page reads the params back on mount to select the channel and open the
 * thread. `/channels` is the older segment (PO-1189); the registry still reads
 * it and the address is rewritten to `/chat` (PO-1200). A `message=` names
 * one message inside the thread to scroll to. Only an address — the server
 * still decides whether the caller may read it.
 */
import { nestPath } from "./nest-url";

export const CHAT_SEGMENT = "chat";

export function channelThreadLink(nestId: string, channel: string, threadId: string, messageId?: string | null): string {
  const q = new URLSearchParams({ channel, thread: threadId });
  if (messageId) q.set("message", messageId);
  return `${nestPath(nestId, CHAT_SEGMENT)}?${q.toString()}`;
}

export function readChannelDeepLink(search: string): { channel: string | null; thread: string | null; message: string | null } {
  const p = new URLSearchParams(search);
  // "#ops" and "ops" name the same channel; the page works with the bare name.
  const channel = (p.get("channel") || "").trim().toLowerCase().replace(/^#+/, "");
  const thread = (p.get("thread") || "").trim();
  const message = (p.get("message") || "").trim();
  const t = channel && thread ? thread : null;
  return { channel: channel || null, thread: t, message: t && message ? message : null };
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
  if (loc.channel && loc.thread) {
    // A message only means something inside the thread it was linked in.
    if (params.get("thread") !== loc.thread) params.delete("message");
    params.set("thread", loc.thread);
  } else {
    params.delete("thread");
    params.delete("message");
  }
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
