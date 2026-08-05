/**
 * The version list sends `content: ""` on every row (bodies are fetched one at
 * a time). Coalescing with `??` kept that empty string, so "Full content"
 * rendered "(no content)" over a version whose body had loaded fine.
 */
import { describe, it, expect } from "vitest";
import { resolveBody } from "../ui/src/components/governance/version-body";

describe("resolveBody", () => {
  it("falls through the list's empty content to the fetched body", () => {
    expect(resolveBody("", "# real body")).toBe("# real body");
  });

  it("reports still-loading while nothing has been fetched", () => {
    expect(resolveBody("", undefined)).toBeUndefined();
  });

  it("keeps null — that version's chain does not reconstruct", () => {
    expect(resolveBody("", null)).toBeNull();
  });

  it("prefers an inline body when a caller passes one", () => {
    expect(resolveBody("inline", "fetched")).toBe("inline");
  });
});
