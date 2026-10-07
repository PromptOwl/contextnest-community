import { describe, it, expect } from "vitest";
import { highlightPayload, parseBridgeMessage } from "./artifact-bridge";
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
      { type: "cn-place", snippet: "x".repeat(121), frac: 0 }, // bridge sends 40
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

// What crosses into untrusted artifact code: quotes from the artifact's own
// text, keyed by throwaway ids. Never thread ids, comment bodies or authors.
describe("highlightPayload (parent → iframe payload)", () => {
  const thread = (id: string, status: "open" | "resolved", quote?: string) => ({
    id,
    status,
    createdAt: "2026-10-07 10:00:00",
    anchor: quote ? { quote, before: "ctx ", after: " tail", line: 3 } : null,
    comments: [{ id: "c1", author: "secret@acme.com", body: "private review note", createdAt: "x" }],
  });

  it("carries only an opaque id, the quote and before — no thread ids, bodies, authors or after-context", () => {
    const p = highlightPayload([thread("thr_secret_1", "open", "MRR of $400K")] as any, "thr_secret_1");
    expect(p.items).toEqual([{ id: "h0", quote: "MRR of $400K", before: "ctx " }]);
    expect(p.active).toBe("h0");
    expect(JSON.stringify(p)).not.toMatch(/thr_secret_1|secret@acme|private review note|tail/);
  });

  it("maps the opaque ids back to threads, and nothing else", () => {
    const p = highlightPayload([thread("t1", "open", "a"), thread("t2", "open", "b")] as any, null);
    expect(p.active).toBeNull();
    expect(p.threadIdFor("h1")).toBe("t2");
    expect(p.threadIdFor("t1")).toBeUndefined();
    expect(p.threadIdFor("h9")).toBeUndefined();
  });

  it("only open, anchored threads", () => {
    const p = highlightPayload(
      [thread("a", "resolved", "q"), thread("b", "open"), thread("c", "open", "q")] as any,
      null,
    );
    expect(p.items.map((i) => p.threadIdFor(i.id))).toEqual(["c"]);
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
