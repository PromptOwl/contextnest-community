import { describe, it, expect } from "vitest";
import { canSeeActivityLog, describeActivity, surfaceLabel, ACTIVITY_FILTERS } from "./activity-log";

describe("activity log helpers (CU-wdqcq03aw2)", () => {
  it("shows the ⋯ Activity entry to owners and nest admins only", () => {
    expect(canSeeActivityLog("owner")).toBe(true);
    expect(canSeeActivityLog("admin")).toBe(true);
    for (const p of ["write", "read", "comment", null, undefined, ""]) {
      expect(canSeeActivityLog(p as any)).toBe(false);
    }
  });

  it("describes who did what, with the agent and version", () => {
    expect(
      describeActivity({ id: "1", type: "edited", nodeId: "n", actor: "a@x.com", agent: "hootie", at: "", version: 3 }),
    ).toBe("a@x.com (via hootie) edited v3");
    expect(describeActivity({ id: "2", type: "read", nodeId: "n", actor: "b@x.com", at: "" })).toBe("b@x.com read");
    expect(describeActivity({ id: "3", type: "exported", nodeId: null, actor: "c@x.com", at: "" })).toBe(
      "c@x.com exported the whole nest",
    );
  });

  it("labels the surface and groups the filters", () => {
    expect(surfaceLabel("mcp")).toBe("MCP");
    expect(surfaceLabel("api")).toBe("web / API");
    expect(surfaceLabel(undefined)).toBeNull();
    expect(ACTIVITY_FILTERS.find((f) => f.id === "access")!.types).toEqual(["read", "retrieved", "exported"]);
  });
});
