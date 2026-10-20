import { describe, it, expect } from "vitest";
import { NEST_TABS, NEST_TAB_LABELS, nestTabFromParam } from "./nest-tabs";

describe("NestView tab slugs", () => {
  it("gives every whitelisted tab a breadcrumb label", () => {
    for (const t of NEST_TABS) expect(NEST_TAB_LABELS[t]).toBeTruthy();
  });

  it("accepts ?tab=stream and labels it Stream (the experimental doc stream tab)", () => {
    expect(nestTabFromParam("stream")).toBe("stream");
    expect(NEST_TAB_LABELS.stream).toBe("Stream");
  });

  it("drops an unknown ?tab=", () => {
    expect(nestTabFromParam("nope")).toBeUndefined();
    expect(nestTabFromParam(null)).toBeUndefined();
  });
});
