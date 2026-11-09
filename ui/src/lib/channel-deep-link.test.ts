import { describe, expect, it } from "vitest";
import { channelHistoryKey, channelThreadLink, readChannelDeepLink, writeChannelParams } from "./channel-deep-link";

describe("AC-MW-01 jump-to-thread: channel deep links", () => {
  it("builds the channels path with channel and thread, and reads it back", () => {
    const link = channelThreadLink("nest 1", "ops", "t-1");
    expect(link).toBe("/nest/nest%201/channels?channel=ops&thread=t-1");
    expect(readChannelDeepLink(link.slice(link.indexOf("?")))).toEqual({ channel: "ops", thread: "t-1" });
  });

  it("ignores a thread without a channel, and an empty link", () => {
    expect(readChannelDeepLink("?thread=t-1")).toEqual({ channel: null, thread: null });
    expect(readChannelDeepLink("")).toEqual({ channel: null, thread: null });
  });
});

describe("AC-UX-02 the URL carries the channel and the open thread", () => {
  const write = (search: string, loc: { channel?: string | null; thread?: string | null }) => {
    const p = new URLSearchParams(search);
    writeChannelParams(p, loc);
    return p.toString();
  };

  it("writes both, and reads the same view back after a reload", () => {
    const qs = write("", { channel: "ops", thread: "t-1" });
    expect(qs).toBe("channel=ops&thread=t-1");
    expect(readChannelDeepLink(`?${qs}`)).toEqual({ channel: "ops", thread: "t-1" });
  });

  it("drops the thread when it closes, and both when no channel is selected", () => {
    expect(write("channel=ops&thread=t-1", { channel: "ops", thread: null })).toBe("channel=ops");
    expect(write("channel=ops&thread=t-1", { channel: null, thread: "t-1" })).toBe("");
    expect(write("channel=ops&thread=t-1&tab=x", {})).toBe("tab=x");
  });

  it("gives every channel and thread its own Back stop", () => {
    const a = channelHistoryKey("n1", "ops", null);
    expect(channelHistoryKey("n1", "ops", null)).toBe(a);
    expect(channelHistoryKey("n1", "ops", "t-1")).not.toBe(a);
    expect(channelHistoryKey("n1", "general", null)).not.toBe(a);
    // No channel yet (landing): nothing to come back to.
    expect(channelHistoryKey("n1", null, null)).toBeNull();
  });
});
