/**
 * Canvas wire labels. A condition longer than the run of wire it sits on used
 * to be cut at both ends with no ellipsis and no way to read it, so what the
 * label promises matters: a visible truncation mark, the whole rule kept for
 * the hover title, and a plate wide enough to cover the text it carries.
 */
import { describe, it, expect } from "vitest";
import { wireLabel } from "../ui/src/lib/wire-label";

describe("wireLabel", () => {
  it("leaves a short label alone, with no ellipsis", () => {
    const { full, short } = wireLabel("next", "");
    expect(full).toBe("next");
    expect(short).toBe("next");
  });

  it("joins the wire type and its condition", () => {
    expect(wireLabel("next", "“sentiment is negative”").short).toBe(
      "next · “sentiment is negative”",
    );
  });

  it("truncates a long condition and marks it, keeping the whole rule", () => {
    const condition = "dsfsdf sdfsdf sdfsdff sf wererwrwerwe rwer rwer";
    const { full, short } = wireLabel("next", condition);
    expect(full).toBe(`next · ${condition}`);
    expect(short.endsWith("…")).toBe(true);
    expect(short.length).toBeLessThan(full.length);
    // The visible text is a prefix of the rule, so it reads as the start of it
    // rather than a middle slice.
    expect(full.startsWith(short.slice(0, -1).trimEnd())).toBe(true);
  });

  it("sizes the plate to the text it has to cover", () => {
    const short = wireLabel("next", "x".repeat(200));
    const long = wireLabel("next", "");
    expect(short.width).toBeGreaterThan(long.width);
    expect(short.width).toBeGreaterThanOrEqual(short.short.length * 6);
  });
});
