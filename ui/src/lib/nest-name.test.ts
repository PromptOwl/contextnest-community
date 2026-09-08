import { describe, it, expect } from "vitest";
import { confirmableName, nestNameProblem } from "./nest-name";

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
