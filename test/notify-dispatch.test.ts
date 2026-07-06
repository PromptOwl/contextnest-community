/**
 * Fan-out isolation for the notification dispatcher: one connector failing
 * must never affect the other, and notifyNestEvent must never throw (it's
 * awaited via `void` off the governance response path). Both connectors are
 * mocked so this asserts the dispatcher's Promise.allSettled semantics
 * directly, independent of Slack/SMTP wiring.
 */
import { describe, it, expect, vi } from "vitest";

// vi.mock is hoisted above these decls, so create the spies via vi.hoisted
// (which runs first) to avoid the temporal-dead-zone reference error.
const { slackSpy, emailSpy } = vi.hoisted(() => ({
  slackSpy: vi.fn(async () => {
    throw new Error("slack down");
  }),
  emailSpy: vi.fn(async () => {}),
}));
vi.mock("../src/notify/slack.js", () => ({ notifySlackForNest: slackSpy }));
vi.mock("../src/notify/email.js", () => ({ notifyEmailForNest: emailSpy }));

import { notifyNestEvent } from "../src/notify/notify.js";

describe("notifyNestEvent fan-out", () => {
  it("a throwing Slack connector does not block email or reject", async () => {
    const details = { status: "approved" as const, docTitle: "D", path: "N" };
    await expect(
      notifyNestEvent("nest1", "msg", details),
    ).resolves.toBeUndefined();
    expect(slackSpy).toHaveBeenCalledWith("nest1", "msg");
    // Email still receives the call — and the structured details — despite Slack throwing.
    expect(emailSpy).toHaveBeenCalledWith("nest1", "msg", details);
  });
});
