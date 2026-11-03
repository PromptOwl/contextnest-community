/**
 * Pill colours and the tags a card leaves out. Priority runs red → grey for any
 * number of levels, stages have fixed colours, and tags nearly every card
 * carries are judged over the whole board.
 */
import { describe, it, expect } from "vitest";
import { priorityTone, stageDot, stageTone, tagPillTone, universalTags } from "../ui/src/lib/tones";

describe("priorityTone", () => {
  const four = ["urgent", "high", "medium", "low"];
  it("runs from red to grey", () => {
    expect(priorityTone(four, "urgent")).toContain("red");
    expect(priorityTone(four, "high")).toContain("orange");
    expect(priorityTone(four, "medium")).toContain("sky");
    expect(priorityTone(four, "low")).toContain("slate");
  });
  it("spreads a nest's own scale the same way", () => {
    const p = ["p0", "p1", "p2"];
    expect(priorityTone(p, "p0")).toContain("red");
    expect(priorityTone(p, "p2")).toContain("slate");
  });
  it("has no tone for no priority or a retired level", () => {
    expect(priorityTone(four, undefined)).toBeUndefined();
    expect(priorityTone(four, "p9")).toBeUndefined();
  });
});

describe("stageTone", () => {
  it("gives each stage its own colour", () => {
    expect(stageTone("done")).toContain("green");
    expect(stageTone("in-review")).toContain("violet");
    expect(stageTone("In Review")).toBe(stageTone("in-review"));
  });
  it("gives an unknown stage a stable colour", () => {
    expect(stageTone("blocked")).toBe(stageTone("blocked"));
    expect(stageTone(undefined)).toBeUndefined();
  });
});

describe("tagPillTone", () => {
  it("colours namespaced tags and leaves flat tags grey", () => {
    expect(tagPillTone("#surface:community")).toBeTruthy();
    expect(tagPillTone("#stage:done")).toBe(stageTone("done"));
    expect(tagPillTone("#projects")).toBeUndefined();
  });
  it("never uses the urgency colours for a hashed value", () => {
    for (const v of ["a", "community", "contextnest", "marketing", "desktop", "po"]) {
      expect(tagPillTone(`surface:${v}`)).not.toMatch(/red|amber|green|rose|orange/);
    }
  });
});

describe("universalTags", () => {
  const card = (...tags: string[]) => tags;
  const board = [
    card("#projects", "#engineering", "#a"),
    card("#projects", "#engineering", "#b"),
    card("#projects", "#engineering"),
    card("#projects", "#engineering", "#a"),
    card("#projects", "#engineering", "#b"),
  ];
  it("finds the tags every card carries", () => {
    expect([...universalTags(board)].sort()).toEqual(["engineering", "projects"]);
  });
  it("hides nothing on a board too small to judge", () => {
    expect(universalTags(board.slice(0, 3)).size).toBe(0);
  });
  it("tolerates a stray card without them", () => {
    const withStray = [...board, ...board, card("#other")];
    expect(universalTags(withStray).has("projects")).toBe(true);
  });
});

describe("stageDot", () => {
  it("colours a stage column and no other", () => {
    expect(stageDot("stage:in-progress")).toBe("bg-sky-500");
    expect(stageDot("#stage:done")).toBe("bg-green-500");
    expect(stageDot("surface:community")).toBeUndefined();
    expect(stageDot("backlog")).toBeUndefined();
  });
  it("gives an unknown stage a stable dot", () => {
    expect(stageDot("stage:blocked")).toBe(stageDot("stage:blocked"));
  });
});
