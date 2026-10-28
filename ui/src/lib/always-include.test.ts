/**
 * The advisory Prime badge mirrors the server: an always-include document
 * (CU-wdqcq05rn0) is prime whatever its own prime flag says.
 */
import { describe, it, expect } from "vitest";
import { isAlwaysIncludeNode, isPrimeNode } from "./api";

describe("isAlwaysIncludeNode", () => {
  it("follows the document flag first, then the tags", () => {
    expect(isAlwaysIncludeNode({ tags: ["#Always-Include"] }, ["always-include"])).toBe(true);
    expect(isAlwaysIncludeNode({ tags: ["always-include"], always_include: false }, ["always-include"])).toBe(false);
    expect(isAlwaysIncludeNode({ tags: [], always_include: true }, [])).toBe(true);
    expect(isAlwaysIncludeNode({ tags: ["other"] }, ["always-include"])).toBe(false);
  });
});

describe("isPrimeNode", () => {
  it("treats an always-include document as prime, even with prime: false", () => {
    expect(isPrimeNode({ tags: ["always-include"], prime: false }, ["prime-document"], ["always-include"])).toBe(true);
    expect(isPrimeNode({ tags: ["always-include"] }, ["prime-document"])).toBe(false);
    expect(isPrimeNode({ tags: ["prime-document"] }, ["prime-document"], ["always-include"])).toBe(true);
  });
});
