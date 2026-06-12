import { describe, it, expect } from "vitest";
import { unifiedDiff } from "../ui/src/components/governance/diff-util";

describe("unifiedDiff", () => {
  it("marks unchanged lines as context", () => {
    expect(unifiedDiff("a\nb", "a\nb")).toBe("  a\n  b");
  });

  it("marks removed and added lines", () => {
    const d = unifiedDiff("a\nb\nc", "a\nx\nc");
    expect(d).toContain("  a");
    expect(d).toContain("- b");
    expect(d).toContain("+ x");
    expect(d).toContain("  c");
  });

  it("handles pure additions", () => {
    expect(unifiedDiff("a", "a\nb")).toBe("  a\n+ b");
  });

  it("handles pure deletions", () => {
    expect(unifiedDiff("a\nb", "a")).toBe("  a\n- b");
  });

  it("diffs against empty", () => {
    expect(unifiedDiff("", "hello")).toBe("- \n+ hello");
  });
});
