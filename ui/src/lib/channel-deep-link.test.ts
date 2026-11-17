import { describe, expect, it } from "vitest";
import { channelThreadLink, readChannelDeepLink } from "./channel-deep-link";

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
