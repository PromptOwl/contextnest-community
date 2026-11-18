/**
 * The history and deep-link decisions App makes around the Channels view
 * (PO-1189), as plain functions: App owns the view and the address bar, and
 * these say what to do with them, so the rules are tested on values instead
 * of only by clicking through the running app.
 */
import { channelNameOfDoc } from "./channel-docs";
import { historyWriteMode } from "./nav-guard";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
/** A history entry App wrote: its state is the view that was on screen. */
const isAppEntry = (state: unknown) => isObject(state) && "page" in state;
/** The document editor's parked leave-guard entry: never ours to rewrite. */
const isParkedEntry = (state: unknown) => isObject(state) && "cnLeaveGuard" in state;

export type HistoryWrite = "push" | "replace" | "stamp" | "none";

/**
 * What the URL sync does with a view change.
 *
 * - the address changes: `push` when the view moved to another node, channel
 *   or thread from an entry App wrote; `replace` otherwise, and always when
 *   the change asked for no Back stop (`forceReplace`: Channels choosing a
 *   channel for an address that named none);
 * - the address is already right: `stamp` the view onto an entry App did not
 *   write (a channel link opened directly), so the next move can push and
 *   Back can restore this view; `none` when there is nothing to do.
 */
export function historyWrite(input: {
  next: string;
  current: string;
  prevKey: string | null;
  key: string | null;
  /** `history.state` of the current entry. */
  state: unknown;
  forceReplace: boolean;
  /** The view asks for its entry to carry it (the Channels view). */
  stampable: boolean;
}): HistoryWrite {
  const onAppEntry = isAppEntry(input.state);
  if (input.next !== input.current) {
    return !input.forceReplace && historyWriteMode(input.prevKey, input.key, onAppEntry) === "push" ? "push" : "replace";
  }
  return input.stampable && !onAppEntry && !isParkedEntry(input.state) ? "stamp" : "none";
}

/**
 * Before leaving the page a row was clicked on (My Work → a channel thread):
 * does its entry still need its view? A page opened directly has none, and
 * the first move away from such an entry reuses it instead of adding a stop.
 */
export function needsViewStamp(state: unknown): boolean {
  return !isAppEntry(state) && !isParkedEntry(state);
}

/**
 * The channel and thread to show after the page asks for `loc`, or null when
 * nothing changes: the Channels view of that nest is not on screen, or it
 * already shows exactly that. Null matters: a "no Back stop" mark set for a
 * change that never happens would apply to the next, unrelated navigation.
 */
export function nextChannelLocation(
  shown: { page: string; nestId?: string; channel?: string; thread?: string },
  nestId: string,
  loc: { channel: string | null; thread?: string | null },
): { channel: string | undefined; thread: string | undefined } | null {
  if (shown.page !== "channels" || shown.nestId !== nestId) return null;
  const channel = loc.channel ?? undefined;
  const thread = (loc.channel && loc.thread) || undefined;
  return shown.channel === channel && shown.thread === thread ? null : { channel, thread };
}

/**
 * The channel a document address should open instead, or null. A channel is a
 * node, so search, a wikilink or a card can address it as a document; a
 * person on the nest gets its conversation, not its node. Someone who holds
 * only a share on the node itself still reads it as a document.
 */
export function channelRedirectTarget(
  nodeId: string,
  ctx: { streamOn: boolean; member: boolean; isChannel: boolean },
): string | null {
  if (!ctx.streamOn || !ctx.member || !ctx.isChannel) return null;
  return channelNameOfDoc(nodeId);
}
