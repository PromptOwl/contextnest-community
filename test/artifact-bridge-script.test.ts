import { describe, it, expect } from "vitest";
import { BRIDGE_JS, injectArtifactBridge } from "../src/shared/artifact-bridge.js";

// The bridge ships as a string, so neither tsc nor the bundler parses it.
// This is the parse check they would otherwise give us.
describe("artifact viewer bridge script", () => {
  it("is syntactically valid JavaScript", () => {
    expect(() => new Function(BRIDGE_JS)).not.toThrow();
  });

  it("guards range creation so one stale quote can't drop every highlight", () => {
    expect(BRIDGE_JS).toMatch(/try \{\s*r\.setStart\(idx\.nodes\[at\]/);
  });

  it("flushes a held goto on visibility change and on the next highlights message", () => {
    expect(BRIDGE_JS).toMatch(/addEventListener\("visibilitychange", flushGo\)/);
    expect(BRIDGE_JS).toMatch(/paint\(items,[^;]+;\s*flushGo\(\);/);
  });

  it("appends after the markup, never ahead of the doctype", () => {
    const out = injectArtifactBridge("<!doctype html><p>x</p>");
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("<script data-cn-bridge>");
  });
});
