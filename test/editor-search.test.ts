import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { findRanges } from "../ui/src/components/MarkdownEditor/extensions/SearchReplace";

const schema = getSchema([StarterKit]);
const doc = schema.node("doc", null, [
  schema.node("paragraph", null, [schema.text("the cat sat on the cat")]),
  schema.node("paragraph", null, [schema.text("CAT")]),
]);

describe("findRanges — in-doc search", () => {
  it("finds all matches case-insensitively by default", () => {
    expect(findRanges(doc, "cat", false).length).toBe(3);
  });
  it("respects case sensitivity", () => {
    expect(findRanges(doc, "cat", true).length).toBe(2);
    expect(findRanges(doc, "CAT", true).length).toBe(1);
  });
  it("empty query yields no matches", () => {
    expect(findRanges(doc, "", false).length).toBe(0);
  });
  it("ranges bound the needle exactly", () => {
    const m = findRanges(doc, "cat", false)[0];
    expect(m.to - m.from).toBe(3);
  });
});
