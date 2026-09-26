import { describe, it, expect } from "vitest";
import { crumbLabelClass } from "./breadcrumb";

describe("crumbLabelClass", () => {
  it("lets the current crumb truncate instead of overflowing an unbreakable name", () => {
    const cls = crumbLabelClass(true);
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("truncate");
    expect(cls).toContain("font-semibold");
  });

  it("lets an ancestor crumb truncate the same way", () => {
    const cls = crumbLabelClass(false);
    expect(cls).toContain("min-w-0");
    expect(cls).toContain("truncate");
    expect(cls).toContain("text-muted-foreground");
  });
});
