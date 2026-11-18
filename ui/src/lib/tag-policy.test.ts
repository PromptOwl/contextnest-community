/** Suggest existing nest tags in the tag field. */
import { describe, it, expect } from "vitest";
import { tagSuggestions } from "./tag-policy";

describe("tagSuggestions", () => {
  it("never offers a ticket number tag (PO-1231)", () => {
    expect(tagSuggestions(["backend", "ticket:qa-1", "#ticket:QA-2"], [])).toEqual(["backend"]);
  });

  it("offers the nest's tags minus the ones already applied, in any casing or # form", () => {
    expect(tagSuggestions(["backend", "Community", "qa"], ["#community", "QA"])).toEqual(["backend"]);
  });

  it("offers every nest tag when none are applied, and nothing for an empty nest", () => {
    expect(tagSuggestions(["a", "b"], [])).toEqual(["a", "b"]);
    expect(tagSuggestions([], ["a"])).toEqual([]);
  });
});
