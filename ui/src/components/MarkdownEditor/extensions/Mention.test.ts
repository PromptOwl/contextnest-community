import { describe, it, expect } from "vitest";
import { findMentions } from "./Mention";

describe("findMentions", () => {
  it("hides the domain: localEnd sits right after the local part", () => {
    const text = "Hey @hiren@promptowl.ai take a look";
    const [m] = findMentions(text);
    expect(text.slice(m.start, m.localEnd)).toBe("@hiren");
    expect(text.slice(m.localEnd, m.end)).toBe("@promptowl.ai");
    expect(m.name).toBe("hiren@promptowl.ai");
  });

  it("shows the whole thing for a plain username — nothing to hide", () => {
    const text = "cc @ada please review";
    const [m] = findMentions(text);
    expect(m.localEnd).toBe(m.end);
    expect(text.slice(m.start, m.end)).toBe("@ada");
  });

  it("shows the whole thing for a parenthesized display name", () => {
    const text = "cc @(Hiren F)";
    const [m] = findMentions(text);
    expect(m.localEnd).toBe(m.end);
    expect(text.slice(m.start, m.end)).toBe("@(Hiren F)");
    expect(m.name).toBe("Hiren F");
  });

  it("handles a mention at the very start of the text", () => {
    const text = "@hiren@promptowl.ai please review";
    const [m] = findMentions(text);
    expect(m.start).toBe(0);
    expect(text.slice(m.start, m.localEnd)).toBe("@hiren");
  });

  it("finds more than one mention in the same line", () => {
    const text = "@a@example.com and @(Bea) both saw this";
    const matches = findMentions(text);
    expect(matches).toHaveLength(2);
    expect(text.slice(matches[0].start, matches[0].localEnd)).toBe("@a");
    expect(text.slice(matches[0].localEnd, matches[0].end)).toBe(
      "@example.com",
    );
    expect(text.slice(matches[1].start, matches[1].end)).toBe("@(Bea)");
  });
});
