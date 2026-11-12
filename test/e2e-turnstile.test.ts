import { describe, it, expect } from "vitest";
import { decide, GATE_STEP, aheadInLine, rateLimitWaitMs } from "../tests/scripts/e2e-turnstile.mjs";

describe("e2e turnstile (one run at a time on the shared server, none dropped)", () => {
  it("goes when no other run is in progress", () => {
    expect(decide(10, [])).toBe("go");
  });

  it("waits while another run is past the gate, whatever its id", () => {
    expect(decide(10, [{ id: 12, gatePassed: true }])).toBe("wait");
    expect(decide(10, [{ id: 8, gatePassed: true }])).toBe("wait");
  });

  it("first come, first served: waits for an older run that has not reached the gate yet", () => {
    expect(decide(10, [{ id: 9, gatePassed: false }])).toBe("wait");
  });

  it("goes ahead of newer runs that are still waiting", () => {
    expect(decide(10, [{ id: 11, gatePassed: false }, { id: 14, gatePassed: false }])).toBe("go");
  });

  it("lets exactly one of several waiting runs go", () => {
    const ids = [21, 22, 23];
    const going = ids.filter((id) => decide(id, ids.filter((o) => o !== id).map((o) => ({ id: o, gatePassed: false }))) === "go");
    expect(going).toEqual([21]);
  });

  it("names the step it looks for in other runs", () => {
    expect(GATE_STEP).toBe("Wait for the shared e2e server");
  });

  it("knows it must wait from the run list alone when an older run is in progress (no per-run jobs calls)", () => {
    expect(aheadInLine(10, [12, 9])).toBe(true);
    expect(aheadInLine(10, [12, 14])).toBe(false);
    expect(aheadInLine(10, [])).toBe(false);
  });

  it("backs off until the rate-limit reset on a 403/429, at least the normal poll", () => {
    const now = 1_000_000_000_000;
    const reset = String(Math.floor(now / 1000) + 300);
    expect(rateLimitWaitMs({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }, now, 60_000)).toBe(300_000);
    expect(rateLimitWaitMs({ status: 429, headers: { "retry-after": "120" } }, now, 60_000)).toBe(120_000);
    expect(rateLimitWaitMs({ status: 429, headers: {} }, now, 60_000)).toBe(60_000);
    expect(rateLimitWaitMs({ status: 500, headers: {} }, now, 60_000)).toBe(60_000);
  });
});
