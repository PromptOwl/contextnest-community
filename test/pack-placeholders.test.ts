import { describe, it, expect } from "vitest";
import {
  extractPlaceholders,
  nestSetupStatus,
} from "../ui/src/lib/placeholders";

describe("extractPlaceholders", () => {
  it("finds unique placeholder labels", () => {
    expect(
      extractPlaceholders("Hi {{client_name}}, goal: {{metric}} by {{date}} for {{client_name}}"),
    ).toEqual(["client_name", "metric", "date"]);
  });

  it("skips fenced code blocks and empty braces", () => {
    expect(
      extractPlaceholders("real {{x}}\n```\nignored {{y}}\n```\n{{}}"),
    ).toEqual(["x"]);
  });

  it("empty content → empty", () => {
    expect(extractPlaceholders("")).toEqual([]);
    expect(extractPlaceholders("no tokens here")).toEqual([]);
  });
});

describe("nestSetupStatus", () => {
  it("lists only docs with remaining placeholders", () => {
    const status = nestSetupStatus([
      { id: "a", title: "Filled", content: "all real facts" },
      { id: "b", title: "Needs work", content: "{{owner}} and {{date}}" },
      { id: "c", title: "No content" },
    ]);
    expect(status).toEqual([
      { id: "b", title: "Needs work", placeholders: ["owner", "date"] },
    ]);
  });
});
