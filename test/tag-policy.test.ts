/**
 * Document tag policy: what the editor accepts, rewrites, or refuses.
 */
import { describe, it, expect } from "vitest";
import { normalizeTagInput, newTags, clampTagInput, tagKey, MAX_TAG_LENGTH } from "../ui/src/lib/tag-policy";

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

  it("refuses a tag with nothing usable in it", () => {
    const { tag, note } = normalizeTagInput("!@#$%^&*");
    expect(tag).toBeNull();
    expect(note).toContain("no usable characters");
  });

  // The engine's TAG_PATTERN is ASCII and letter-initial. Anything wider was
  // accepted here and then refused by the server, taking the whole save with it.
  it("folds a tag to what the server will actually store", () => {
    expect(normalizeTagInput("2024-plan").tag).toBe("plan");
    expect(normalizeTagInput("dept:sales").tag).toBe("dept:sales");
    expect(normalizeTagInput("v2.0").tag).toBe("v20");
  });

  // An accent has an ASCII base letter, so keep it — dropping the character
  // whole turned "café" into a different word (CU-wdqcq01e79).
  it("folds an accented letter to its base instead of dropping it", () => {
    const { tag, note } = normalizeTagInput("café");
    expect(tag).toBe("cafe");
    expect(note).toContain("cafe");
    expect(normalizeTagInput("Über-Sicherheit").tag).toBe("uber-sicherheit");
    // No ASCII base to fall back to — still refused.
    expect(normalizeTagInput("漢字").tag).toBeNull();
    expect(tagKey("Café")).toBe(tagKey("cafe"));
  });

  it("ignores an empty token without complaining", () => {
    expect(normalizeTagInput("  ")).toEqual({ tag: null, note: null });
  });
});

describe("newTags", () => {
  it("drops a candidate already present in any casing", () => {
    expect(newTags(["#bug"], ["bug"])).toEqual([]);
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

describe("tagKey", () => {
  it("keys a legacy '#bug' the same as a freshly typed 'bug'", () => {
    expect(tagKey("#bug")).toBe(tagKey("bug"));
    expect(tagKey("#Bug")).toBe("bug");
  });

  it("keeps an unusable value as its own key rather than dropping it", () => {
    expect(tagKey("!!!")).toBe("!!!");
  });
});
