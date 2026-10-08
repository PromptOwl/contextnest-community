import { describe, it, expect } from "vitest";
import { findPlace, foldText, placeSnippet, sourceRangesForAnchors } from "./view-place";

describe("foldText", () => {
  it("drops whitespace and markdown emphasis, keeping an index map", () => {
    // Whitespace goes entirely: the DOM puts no space between two blocks,
    // extracted text puts a newline, markdown a blank line.
    const { folded, map } = foldText("Hello  **big**\n world");
    expect(folded).toBe("Hellobigworld");
    // Each folded char points back at its original position.
    expect("Hello  **big**\n world"[map[folded.indexOf("b")]]).toBe("b");
    expect("Hello  **big**\n world"[map[folded.indexOf("w")]]).toBe("w");
  });
});

describe("placeSnippet", () => {
  it("takes the words at the offset, whitespace-normalized", () => {
    const text = "Intro line.\n\nThe quarterly   revenue grew by forty percent this year.";
    const at = text.indexOf("quarterly");
    expect(placeSnippet(text, at)).toMatch(/^quarterly revenue grew/);
  });

  it("is empty past the end of the text", () => {
    expect(placeSnippet("abc", 10)).toBe("");
  });
});

describe("findPlace (where you were, in the other view)", () => {
  const rendered = "Intro\nThe quarterly revenue grew by forty percent.\nOutro";

  it("finds the same passage when only whitespace differs", () => {
    const off = findPlace(rendered, { snippet: "quarterly   revenue\ngrew", frac: 0.5 });
    expect(off).toBe(rendered.indexOf("quarterly"));
  });

  it("finds a rendered passage inside its markdown source", () => {
    const source = "# Intro\n\nThe **quarterly** revenue _grew_ by forty percent.\n\nOutro";
    const off = findPlace(source, { snippet: "quarterly revenue grew by forty", frac: 0.4 });
    expect(off).not.toBeNull();
    expect(source.slice(off!, off! + 9)).toBe("quarterly");
  });

  it("picks the occurrence nearest to where you were for a repeated phrase", () => {
    const text = "Summary of results.\n" + "filler ".repeat(200) + "\nSummary of results.\n" + "filler ".repeat(20);
    const second = text.lastIndexOf("Summary");
    const off = findPlace(text, { snippet: "Summary of results.", frac: second / text.length });
    expect(off).toBe(second);
    expect(findPlace(text, { snippet: "Summary of results.", frac: 0 })).toBe(0);
  });

  it("falls back to a shorter prefix when the tail of the snippet changed", () => {
    const text = "Alpha. The quarterly revenue shrank badly.";
    const off = findPlace(text, { snippet: "The quarterly revenue grew by forty percent", frac: 0.2 });
    expect(off).toBe(text.indexOf("The quarterly"));
  });

  it("returns null when the passage is not there at all", () => {
    expect(findPlace("nothing alike here", { snippet: "completely different words", frac: 0 })).toBeNull();
  });
});

describe("sourceRangesForAnchors (highlights in the raw markdown)", () => {
  const src = "# Plan\n\nWe will **ship the beta** in May.\n\nWe will ship the beta again later.\n";

  it("maps an anchor quote (rendered text) onto its span in the source, through emphasis", () => {
    const [r] = sourceRangesForAnchors(src, [
      { id: "t1", anchor: { quote: "ship the beta in May", before: "Plan\nWe will " } },
    ]);
    expect(r.id).toBe("t1");
    expect(src.slice(r.start, r.end)).toBe("ship the beta** in May");
  });

  it("uses the `before` context to pick the right occurrence", () => {
    const [r] = sourceRangesForAnchors(src, [
      { id: "t2", anchor: { quote: "ship the beta", before: "in May.\nWe will " } },
    ]);
    expect(r.start).toBe(src.lastIndexOf("ship the beta"));
  });

  it("omits threads whose quote is not in the source (no misplaced paint)", () => {
    expect(
      sourceRangesForAnchors(src, [{ id: "t3", anchor: { quote: "deleted sentence", before: "" } }]),
    ).toEqual([]);
  });

  it("skips a repeated quote whose `before` context matches neither spot (no guessing)", () => {
    expect(
      sourceRangesForAnchors(src, [{ id: "t5", anchor: { quote: "ship the beta", before: "stale context " } }]),
    ).toEqual([]);
  });

  it("still paints a unique quote when its `before` context has gone stale", () => {
    const [r] = sourceRangesForAnchors(src, [{ id: "t6", anchor: { quote: "again later", before: "stale " } }]);
    expect(src.slice(r.start, r.end)).toBe("again later");
  });

  it("skips whole-document threads", () => {
    expect(sourceRangesForAnchors(src, [{ id: "t4", anchor: null }])).toEqual([]);
  });
});
