import { describe, it, expect } from "vitest";
import {
  confirmableName,
  withNestName,
  nestNameProblem,
  MAX_NEST_NAME_LENGTH,
} from "./nest-name";

describe("nestNameProblem", () => {
  it("accepts a plain name", () => {
    expect(nestNameProblem("Research Notes")).toBeNull();
  });

  it("names the tag as the problem instead of calling it empty", () => {
    const problem = nestNameProblem("<img src=x onerror=alert(1)>");
    expect(problem).toMatch(/plain text/i);
  });

  it("refuses a name carrying a tag rather than silently stripping it", () => {
    expect(nestNameProblem("Research <b>Notes</b>")).toMatch(/plain text/i);
  });

  it("accepts angle brackets that are not a tag", () => {
    expect(nestNameProblem("Roadmap <2026> plan")).toBeNull();
  });

  it("keeps the empty and slug refusals", () => {
    expect(nestNameProblem("   ")).toMatch(/required/i);
    expect(nestNameProblem("###")).toMatch(/slug/i);
  });
});

describe("confirmableName", () => {
  it("matches a name the way the dialog renders it", () => {
    expect(confirmableName("Roadmap  plan")).toBe(confirmableName("Roadmap plan"));
  });

  it("tolerates the whitespace a paste carries", () => {
    expect(confirmableName("  Roadmap plan ")).toBe(confirmableName("Roadmap plan"));
  });

  it("still separates a different name", () => {
    expect(confirmableName("Roadmap plans")).not.toBe(confirmableName("Roadmap plan"));
  });
});

describe("nest name length", () => {
  it("accepts a name at the cap and refuses one past it", () => {
    expect(nestNameProblem("n".repeat(MAX_NEST_NAME_LENGTH))).toBeNull();
    expect(nestNameProblem("n".repeat(MAX_NEST_NAME_LENGTH + 1))).toMatch(
      /100 characters/,
    );
  });
});

describe("withNestName", () => {
  it("renames a view of the same nest", () => {
    const view = { page: "board", nestId: "n1", nestName: "Old", tab: "x" };
    expect(withNestName(view, "n1", "New")).toEqual({ ...view, nestName: "New" });
  });

  it("leaves a view of another nest, or a view with no nest, untouched", () => {
    const other = { page: "nest", nestId: "n2", nestName: "Other" };
    const dash = { page: "dashboard" };
    expect(withNestName(other, "n1", "New")).toBe(other);
    expect(withNestName(dash, "n1", "New")).toBe(dash);
  });
});
