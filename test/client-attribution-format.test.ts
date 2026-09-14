/**
 * `formatClient` — how an attribution block reads in the UI (version history
 * and the activity trace share it). Pure rendering: it must never drop a key
 * the caller recorded, and never mangle a hostile value into something else.
 */
import { describe, it, expect } from "vitest";
import { formatClient } from "../ui/src/lib/client-attribution";

describe("formatClient", () => {
  it("puts the agent first, then the session, then custom keys in order", () => {
    expect(
      formatClient({ session_id: "s-9f2", agent: "claude-code", run: 7 }),
    ).toBe("claude-code · s-9f2 · run=7");
  });

  it("renders a partial block without leaving empty separators", () => {
    expect(formatClient({ agent: "claude-code" })).toBe("claude-code");
    expect(formatClient({ session_id: "s-1" })).toBe("s-1");
    expect(formatClient({ run: 7 })).toBe("run=7");
  });

  it("passes hostile values through unchanged — escaping is the renderer's job", () => {
    const nasty = "<script>alert('x')</script>";
    expect(formatClient({ agent: nasty })).toBe(nasty);
    expect(formatClient({ agent: "a\nb", session_id: 'q"q' })).toBe(
      'a\nb · q"q',
    );
  });

  it("keeps booleans and numeric-looking strings as the caller sent them", () => {
    expect(formatClient({ agent: "a", ci: true, version: "1.0" })).toBe(
      "a · ci=true · version=1.0",
    );
  });
});
