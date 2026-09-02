/**
 * Document tag policy: what the editor accepts, rewrites, or refuses.
 */
import { describe, it, expect } from "vitest";
import { normalizeTagInput, newTags, clampTagInput, MAX_TAG_LENGTH } from "../ui/src/lib/tag-policy";

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

describe("newTags", () => {
  it("drops a candidate already present in any casing", () => {
    expect(newTags(["Bug", "api"], ["bug", "v2"])).toEqual(["v2"]);
  });

  it("drops a repeat within the same batch", () => {
    expect(newTags([], ["api", "api"])).toEqual(["api"]);
  });

  it("keeps everything when nothing collides", () => {
    expect(newTags(["api"], ["v2", "infra"])).toEqual(["v2", "infra"]);
  });
});

describe("clampTagInput", () => {
  it("trims a single over-long tag to the tag limit", () => {
    const long = "a".repeat(MAX_TAG_LENGTH + 30);
    expect(clampTagInput(long)).toHaveLength(MAX_TAG_LENGTH);
  });

  it("keeps a multi-tag paste whole, capping each token", () => {
    const long = "b".repeat(MAX_TAG_LENGTH + 5);
    expect(clampTagInput(`api, v2 ${long}`)).toBe(
      `api, v2 ${"b".repeat(MAX_TAG_LENGTH)}`,
    );
  });

  it("does not count a leading # against the limit", () => {
    const tag = "c".repeat(MAX_TAG_LENGTH);
    expect(clampTagInput(`#${tag}`)).toBe(`#${tag}`);
  });

  it("leaves a short input untouched", () => {
    expect(clampTagInput("api, v2 ")).toBe("api, v2 ");
  });
});
