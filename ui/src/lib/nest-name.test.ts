import { describe, it, expect } from "vitest";
import { nestNameProblem } from "./nest-name";

describe("nestNameProblem", () => {
  it("accepts a plain name", () => {
    expect(nestNameProblem("Research Notes")).toBeNull();
  });

  it("names markup as the problem instead of calling it empty", () => {
    const problem = nestNameProblem("<img src=x onerror=alert(1)>");
    expect(problem).toMatch(/markup/i);
  });

  it("still accepts a name that merely contains markup", () => {
    expect(nestNameProblem("Research <b>Notes</b>")).toBeNull();
  });

  it("keeps the empty and slug refusals", () => {
    expect(nestNameProblem("   ")).toMatch(/required/i);
    expect(nestNameProblem("###")).toMatch(/slug/i);
  });
});
