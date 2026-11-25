import { describe, expect, it } from "vitest";
import { enterAddsLine, enterSends } from "./composer-keys";

describe("AC-UX-17 Enter sends, Shift+Enter adds a line (channel composer and reply box)", () => {
  const desktop = { coarsePointer: false };

  it("sends on a plain Enter", () => {
    expect(enterSends({ key: "Enter" }, desktop)).toBe(true);
  });

  it("adds a line on Shift+Enter, and leaves other chords alone", () => {
    expect(enterSends({ key: "Enter", shiftKey: true }, desktop)).toBe(false);
    expect(enterSends({ key: "Enter", altKey: true }, desktop)).toBe(false);
    expect(enterSends({ key: "Enter", ctrlKey: true }, desktop)).toBe(false);
    expect(enterSends({ key: "Enter", metaKey: true }, desktop)).toBe(false);
    expect(enterSends({ key: "a" }, desktop)).toBe(false);
  });

  it("EX-20 Ctrl+Enter and Cmd+Enter add a line; a plain or composing Enter does not", () => {
    expect(enterAddsLine({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(enterAddsLine({ key: "Enter", metaKey: true })).toBe(true);
    expect(enterAddsLine({ key: "Enter" })).toBe(false);
    expect(enterAddsLine({ key: "Enter", ctrlKey: true, isComposing: true })).toBe(false);
  });

  it("never sends while an input method is composing a character", () => {
    expect(enterSends({ key: "Enter", isComposing: true }, desktop)).toBe(false);
    expect(enterSends({ key: "Enter", keyCode: 229 }, desktop)).toBe(false);
  });

  it("on a touch device Enter adds a line and the button sends", () => {
    expect(enterSends({ key: "Enter" }, { coarsePointer: true })).toBe(false);
  });
});
