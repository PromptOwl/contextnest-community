import { describe, it, expect } from "vitest";
import { normalizeTagInput, tagKey } from "./tag-policy";

describe("normalizeTagInput", () => {
  it("keeps the base letter of an accented character", () => {
    const { tag, note } = normalizeTagInput("café");
    expect(tag).toBe("cafe");
    // The rewrite still has to be visible — it is not what the user typed.
    expect(note).toMatch(/cafe/);
  });

  it("keeps accented characters that carry the whole word", () => {
    expect(normalizeTagInput("Über-Sicherheit").tag).toBe("uber-sicherheit");
  });

  it("still drops characters with no ASCII base", () => {
    expect(normalizeTagInput("🚀rocket").tag).toBe("rocket");
    expect(normalizeTagInput("漢字").tag).toBeNull();
  });

  it("keys an accented tag the same as its plain spelling", () => {
    expect(tagKey("Café")).toBe(tagKey("cafe"));
  });
});
