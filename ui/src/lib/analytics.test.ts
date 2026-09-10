import { describe, it, expect, vi, beforeEach } from "vitest";

const capture = vi.fn();
const init = vi.fn();
vi.mock("posthog-js", () => ({ default: { init, capture } }));

import { initAnalytics, track, resetAnalyticsForTests } from "./analytics";

beforeEach(() => {
  capture.mockClear();
  init.mockClear();
  resetAnalyticsForTests();
});

describe("analytics", () => {
  it("flushes events fired before the key arrived", async () => {
    // The first page view fires on mount; the key only arrives with /health,
    // one round-trip later. Dropping it would lose the landing view of every
    // session that never navigates.
    track("$pageview", { page: "dashboard" });
    initAnalytics("phc_test", "https://eu.i.posthog.com");
    await vi.waitFor(() => expect(capture).toHaveBeenCalled());

    expect(init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({ api_host: "https://eu.i.posthog.com" }),
    );
    expect(capture).toHaveBeenCalledWith("$pageview", { page: "dashboard" });
  });

  it("captures events fired after init", async () => {
    initAnalytics("phc_test");
    track("$pageview", { page: "nest" });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledWith("$pageview", { page: "nest" }));
  });

  it("stays silent when the server configured no key", async () => {
    track("$pageview", { page: "dashboard" });
    initAnalytics(null);
    // Nothing loads, nothing sends — and a later init with a key must not
    // replay events buffered while analytics was off.
    initAnalytics("phc_test");
    await Promise.resolve();
    expect(capture).not.toHaveBeenCalled();
  });
});
