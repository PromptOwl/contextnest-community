import { describe, it, expect } from "vitest";
import { parseBridgeMessage } from "./artifact-bridge";
import { hostedArtifactUrl } from "./api";

// The iframe is attacker-authorable HTML: everything it posts is untrusted.
describe("parseBridgeMessage", () => {
  it("accepts the bridge's ready / place / activate messages", () => {
    expect(parseBridgeMessage({ type: "cn-ready" })).toEqual({ type: "cn-ready" });
    expect(parseBridgeMessage({ type: "cn-place", snippet: "Slide 3 MRR", frac: 0.25 })).toEqual({
      type: "cn-place",
      snippet: "Slide 3 MRR",
      frac: 0.25,
    });
    expect(parseBridgeMessage({ type: "cn-activate", id: "th_1" })).toEqual({
      type: "cn-activate",
      id: "th_1",
    });
  });

  it("rejects anything else", () => {
    for (const bad of [
      null,
      "cn-ready",
      { type: "cn-goto", snippet: "x", frac: 0 }, // parent→iframe only
      { type: "cn-place", snippet: 5, frac: 0 },
      { type: "cn-place", snippet: "x", frac: Number.NaN },
      { type: "cn-place", snippet: "x".repeat(1000), frac: 0 },
      { type: "cn-activate", id: {} },
      { type: "cn-activate", id: "x".repeat(500) },
    ]) {
      expect(parseBridgeMessage(bad)).toBeNull();
    }
  });

  it("clamps frac into [0, 1]", () => {
    expect(parseBridgeMessage({ type: "cn-place", snippet: "x", frac: 7 })).toMatchObject({ frac: 1 });
    expect(parseBridgeMessage({ type: "cn-place", snippet: "x", frac: -2 })).toMatchObject({ frac: 0 });
  });
});

describe("hostedArtifactUrl embed flag", () => {
  it("leaves the plain URL (Open in new tab, text fetch) unchanged", () => {
    expect(hostedArtifactUrl("n1", "nodes/deck", 3, 1)).toMatch(/\/nests\/n1\/nodes\/deck\/hosted\?v=3&_=1$/);
  });

  it("adds embed=1 only when asked", () => {
    expect(hostedArtifactUrl("n1", "nodes/deck", null, null, { embed: true })).toMatch(/hosted\?embed=1$/);
  });
});
