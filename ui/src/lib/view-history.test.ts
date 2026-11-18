/** The history and deep-link decisions App makes for the Channels view (PO-1189), as plain functions. */
import { describe, expect, it } from "vitest";
import { channelRedirectTarget, historyWrite, nextChannelLocation, needsViewStamp } from "./view-history";

const appEntry = { page: "channels" };

describe("AC-UX-02 how a view change is written to history", () => {
  const base = { next: "/nest/n1/channels?channel=ops", current: "/nest/n1/channels?channel=general", prevKey: "/nest/n1/channels|n1/#general/", key: "/nest/n1/channels|n1/#ops/", state: appEntry, forceReplace: false, stampable: true };

  it("another channel or thread adds a Back stop", () => {
    expect(historyWrite(base)).toBe("push");
    expect(historyWrite({ ...base, next: "/nest/n1/channels?channel=general&thread=t1", key: "/nest/n1/channels|n1/#general/t1" })).toBe("push");
  });

  it("choosing the landing channel replaces, so Back does not bounce", () => {
    expect(historyWrite({ ...base, current: "/nest/n1/channels", prevKey: "/nest/n1/channels|", forceReplace: true })).toBe("replace");
  });

  it("the first move away from an entry the app did not write reuses it", () => {
    expect(historyWrite({ ...base, state: null })).toBe("replace");
    expect(historyWrite({ ...base, state: { cnLeaveGuard: true } })).toBe("replace");
  });

  it("the same view again replaces", () => {
    expect(historyWrite({ ...base, next: "/nest/n1/channels?channel=general&x=1", key: base.prevKey })).toBe("replace");
  });

  it("a channel link opened directly gets its view stamped once, so the next move can push and Back can restore it", () => {
    const direct = { ...base, next: base.current, key: base.prevKey, prevKey: null, state: null };
    expect(historyWrite(direct)).toBe("stamp");
    expect(historyWrite({ ...direct, state: appEntry })).toBe("none");
    // Not the editor's parked leave-guard entry, and not a view that never asked for it.
    expect(historyWrite({ ...direct, state: { cnLeaveGuard: true } })).toBe("none");
    expect(historyWrite({ ...direct, stampable: false })).toBe("none");
  });

  it("says when the entry a row was clicked on needs its view before leaving (My Work opened directly)", () => {
    expect(needsViewStamp(null)).toBe(true);
    expect(needsViewStamp({})).toBe(true);
    expect(needsViewStamp(appEntry)).toBe(false);
    expect(needsViewStamp({ cnLeaveGuard: true })).toBe(false);
  });
});

describe("AC-UX-02 selecting a channel or thread from the page", () => {
  const shown = { page: "channels", nestId: "n1", channel: "general", thread: undefined as string | undefined };

  it("returns the new channel and thread", () => {
    expect(nextChannelLocation(shown, "n1", { channel: "ops" })).toEqual({ channel: "ops", thread: undefined });
    expect(nextChannelLocation(shown, "n1", { channel: "general", thread: "t1" })).toEqual({ channel: "general", thread: "t1" });
  });

  it("a thread without a channel is dropped", () => {
    expect(nextChannelLocation(shown, "n1", { channel: null, thread: "t1" })).toEqual({ channel: undefined, thread: undefined });
  });

  it("is nothing when the view would not change, or another page or nest is on screen", () => {
    expect(nextChannelLocation(shown, "n1", { channel: "general" })).toBeNull();
    expect(nextChannelLocation({ ...shown, thread: "t1" }, "n1", { channel: "general", thread: "t1" })).toBeNull();
    expect(nextChannelLocation({ ...shown, page: "nest" }, "n1", { channel: "ops" })).toBeNull();
    expect(nextChannelLocation(shown, "n2", { channel: "ops" })).toBeNull();
  });
});

describe("a channel node opened as a document goes to the Channels page (PO-1189)", () => {
  const on = { streamOn: true, member: true, isChannel: true };

  it("redirects a member to that channel while channels are on", () => {
    expect(channelRedirectTarget("nodes/channels/ops", on)).toBe("ops");
  });

  it("leaves everything else as a document", () => {
    expect(channelRedirectTarget("nodes/launch-plan", on)).toBeNull();
    expect(channelRedirectTarget("nodes/channels/ops", { ...on, streamOn: false })).toBeNull();
    // Someone who holds only a share on the channel node reads it as a document.
    expect(channelRedirectTarget("nodes/channels/ops", { ...on, member: false })).toBeNull();
    // A plain document filed under channels/.
    expect(channelRedirectTarget("nodes/channels/meeting-notes", { ...on, isChannel: false })).toBeNull();
    expect(channelRedirectTarget("new", on)).toBeNull();
  });
});
