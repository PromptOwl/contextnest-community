/**
 * Document tag policy: what the editor accepts, rewrites, or refuses.
 */
import { describe, it, expect } from "vitest";
import { normalizeTagInput, MAX_TAG_LENGTH } from "../ui/src/lib/tag-policy";

describe("normalizeTagInput", () => {
  it("keeps a plain tag and strips a leading #", () => {
    expect(normalizeTagInput("#api-v2")).toEqual({ tag: "api-v2", note: null });
  });

  it("lowercases so case-variants collapse to one tag, silently", () => {
    expect(normalizeTagInput("Bug")).toEqual({ tag: "bug", note: null });
    expect(normalizeTagInput("TAG").tag).toBe(normalizeTagInput("tag").tag);
  });

  it("caps an over-long tag and says so", () => {
    const long = "a".repeat(MAX_TAG_LENGTH + 20);
    const { tag, note } = normalizeTagInput(long);
    expect(tag).toHaveLength(MAX_TAG_LENGTH);
    expect(note).toContain(`${MAX_TAG_LENGTH} characters`);
  });

  it("drops path separators and emoji", () => {
    expect(normalizeTagInput("a/b/c").tag).toBe("abc");
    expect(normalizeTagInput("🚀rocket").tag).toBe("rocket");
  });

  it("refuses a tag with no letters or digits", () => {
    const { tag, note } = normalizeTagInput("!@#$%^&*");
    expect(tag).toBeNull();
    expect(note).toContain("no letters or digits");
  });

  it("ignores an empty token without complaining", () => {
    expect(normalizeTagInput("  ")).toEqual({ tag: null, note: null });
  });
});
