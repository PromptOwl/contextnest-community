import { describe, it, expect } from "vitest";
import { DEFAULT_NEST_TAB, NEST_TABS, NEST_TAB_LABELS, nestTabFromParam } from "./nest-tabs";

describe("NestView tab slugs", () => {
  it("gives every whitelisted tab a breadcrumb label", () => {
    for (const t of NEST_TABS) expect(NEST_TAB_LABELS[t]).toBeTruthy();
  });

  it("accepts ?tab=stream and labels it Stream (the experimental doc stream tab)", () => {
    expect(nestTabFromParam("stream")).toBe("stream");
    expect(NEST_TAB_LABELS.stream).toBe("Stream");
  });

  it("keeps ?tab=instructions (the nest Instructions tab)", () => {
    expect(nestTabFromParam("instructions")).toBe("instructions");
    expect(NEST_TAB_LABELS.instructions).toBe("Instructions");
  });

  it("drops an unknown ?tab=", () => {
    expect(nestTabFromParam("nope")).toBeUndefined();
    expect(nestTabFromParam(null)).toBeUndefined();
  });
});

// po-1213: Documents is the nest's one home.
describe("AC-NH-01: no Overview tab", () => {
  it("Given an old ?tab=overview link, then it opens Documents", () => {
    expect(nestTabFromParam("overview")).toBe("documents");
  });

  it("Given the tab whitelist, then Overview is not a tab and Documents is the default", () => {
    expect(NEST_TABS).not.toContain("overview");
    expect(DEFAULT_NEST_TAB).toBe("documents");
  });

  it("Given ?tab=fields, then it still resolves (the ⋯ menu opens Fields)", () => {
    expect(nestTabFromParam("fields")).toBe("fields");
  });
});
