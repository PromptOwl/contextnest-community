/**
 * Fan-out isolation for the notification dispatcher: one connector failing
 * must never affect the others, and notifyNestEvent must never throw (it's
 * awaited via `void` off the governance response path). All three connectors
 * (Slack, Microsoft Teams, email) are mocked so this asserts the dispatcher's
 * Promise.allSettled semantics directly, independent of the wire formats.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// vi.mock is hoisted above these decls, so create the spies via vi.hoisted
// (which runs first) to avoid the temporal-dead-zone reference error.
const { slackSpy, msteamsSpy, emailSpy } = vi.hoisted(() => ({
  slackSpy: vi.fn(async () => {
    throw new Error("slack down");
  }),
  msteamsSpy: vi.fn(async () => {
    throw new Error("teams down");
  }),
  emailSpy: vi.fn(async () => {}),
}));
vi.mock("../src/notify/slack.js", () => ({ notifySlackForNest: slackSpy }));
vi.mock("../src/notify/msteams.js", () => ({ notifyMsTeamsForNest: msteamsSpy }));
vi.mock("../src/notify/email.js", () => ({ notifyEmailForNest: emailSpy }));

import { notifyNestEvent } from "../src/notify/notify.js";

// Connectors fire on the debounce flush, not synchronously — give it a beat.
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("notifyNestEvent fan-out", () => {
  beforeAll(() => {
    // A connector must be configured or the dispatcher short-circuits before
    // buffering. These URLs only gate dispatch; the connectors are mocked, so
    // no real Slack/SMTP call happens. Small window for a near-instant flush.
    process.env.NOTIFY_DEBOUNCE_MS = "5";
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T/B/X";
    process.env.MSTEAMS_WEBHOOK_URL = "https://prod-01.westus.logic.azure.com/workflows/T/invoke";
    process.env.SMTP_URL = "smtps://u:p@smtp.test:465";
  });
  afterAll(() => {
    delete process.env.NOTIFY_DEBOUNCE_MS;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.MSTEAMS_WEBHOOK_URL;
    delete process.env.SMTP_URL;
  });

  it("throwing Slack AND Teams connectors do not block email, and the dispatch never rejects", async () => {
    const details = { status: "approved" as const, docTitle: "D", path: "N" };
    // notifyNestEvent buffers and resolves immediately (fire-and-forget) — it
    // must never surface a connector failure to the awaiting governance path.
    await expect(
      notifyNestEvent("nest1", "msg", details),
    ).resolves.toBeUndefined();

    // On flush the connectors fan out under Promise.allSettled, so Slack and
    // Teams both throwing doesn't stop email from receiving the call +
    // structured details — 3-way isolation.
    await settle();
    expect(slackSpy).toHaveBeenCalledWith("nest1", "msg");
    expect(msteamsSpy).toHaveBeenCalledWith("nest1", "msg");
    expect(emailSpy).toHaveBeenCalledWith("nest1", "msg", details);
  });
});
