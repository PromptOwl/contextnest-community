import { describe, it, expect } from "vitest";
import { outdatedThreadIds, paintableThreads, splitThreads } from "./comment-threads";
import { locateInText } from "./anchor-highlight";

type T = {
  id: string;
  status: "open" | "resolved";
  createdAt: string;
  anchor: { quote: string; before: string; after: string } | null;
};

const thread = (
  id: string,
  status: "open" | "resolved",
  createdAt: string,
  quote?: string,
): T => ({
  id,
  status,
  createdAt,
  anchor: quote ? { quote, before: "", after: "" } : null,
});

describe("splitThreads (rail sections)", () => {
  it("puts open threads in the rail and resolved ones in their own section", () => {
    const { open, resolved } = splitThreads([
      thread("a", "open", "2026-10-01 09:00:00"),
      thread("b", "resolved", "2026-10-01 10:00:00"),
      thread("c", "open", "2026-10-01 11:00:00"),
    ]);
    // Newest first in each section.
    expect(open.map((t) => t.id)).toEqual(["c", "a"]);
    expect(resolved.map((t) => t.id)).toEqual(["b"]);
  });

  it("counts open threads only, so resolving drops the header number", () => {
    const threads = [
      thread("a", "open", "2026-10-01 09:00:00"),
      thread("b", "resolved", "2026-10-01 10:00:00"),
    ];
    expect(splitThreads(threads).open).toHaveLength(1);
  });
});

describe("paintableThreads (document highlights)", () => {
  it("paints anchored open threads, never resolved or whole-document ones", () => {
    const painted = paintableThreads([
      thread("open-anchored", "open", "x", "the plan"),
      thread("resolved-anchored", "resolved", "x", "the plan"),
      thread("open-whole-doc", "open", "x"),
    ]);
    expect(painted.map((t) => t.id)).toEqual(["open-anchored"]);
  });
});

describe("outdatedThreadIds (text changed label)", () => {
  const text = "We ship the beta on Friday. Pricing is $10.";

  it("flags a thread whose quote is no longer in the document", () => {
    const ids = outdatedThreadIds(
      [
        thread("still-there", "open", "x", "ship the beta"),
        thread("gone", "open", "x", "Pricing is $20"),
        thread("whole-doc", "open", "x"),
      ],
      text,
    );
    expect([...ids]).toEqual(["gone"]);
  });

  it("flags resolved threads too, so an expanded one still says so", () => {
    const ids = outdatedThreadIds([thread("r", "resolved", "x", "Monday")], text);
    expect(ids.has("r")).toBe(true);
  });

  it("agrees with the highlighter's locate: found means not outdated", () => {
    const anchor = { quote: "Friday", before: "", after: "" };
    expect(locateInText(text, anchor)).not.toBeNull();
    expect(outdatedThreadIds([{ id: "t", anchor }], text).size).toBe(0);
  });

  it("uses the before-context to pick the right repeat, like the highlighter", () => {
    const repeated = "alpha beta. gamma beta.";
    const loc = locateInText(repeated, { quote: "beta", before: "gamma ", after: "" });
    expect(loc).toEqual({ start: 18, end: 22 });
  });
});
