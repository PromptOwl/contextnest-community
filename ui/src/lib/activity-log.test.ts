import { describe, it, expect } from "vitest";
import { canSeeActivityLog, activityAction, activityVersion, surfaceLabel, ACTIVITY_FILTERS } from "./activity-log";

describe("activity log helpers (CU-wdqcq03aw2)", () => {
  it("shows the ⋯ Activity entry to owners and nest admins only", () => {
    expect(canSeeActivityLog("owner")).toBe(true);
    expect(canSeeActivityLog("admin")).toBe(true);
    for (const p of ["write", "read", "comment", null, undefined, ""]) {
      expect(canSeeActivityLog(p as any)).toBe(false);
    }
  });

  it("names the action, folding a pull's detail in", () => {
    const base = { nodeId: "n", actor: "a@x.com", at: "" };
    expect(activityAction({ ...base, id: "1", type: "edited" })).toBe("Edited");
    expect(activityAction({ ...base, id: "2", type: "retrieved", detail: "search" })).toBe("Pulled into search");
    expect(activityAction({ ...base, id: "3", type: "retrieved" })).toBe("Pulled into a search / answer");
    expect(activityAction({ ...base, id: "4", type: "read", detail: "context_get" })).toBe("Read (context_get)");
    expect(activityAction({ ...base, id: "5", type: "exported", nodeId: null })).toBe("Exported the whole nest");
    expect(activityAction({ ...base, id: "6", type: "exported", nodeId: null, detail: "decision ledger export failed (csv)" })).toBe(
      "Exported: decision ledger export failed (csv)",
    );
  });

  it("names the version a change sealed or a read was served, never an export's", () => {
    const base = { nodeId: "n", actor: "a@x.com", at: "" };
    expect(activityVersion({ ...base, id: "1", type: "edited", version: 3 })).toBe(3);
    expect(activityVersion({ ...base, id: "2", type: "retrieved", version: 2 })).toBe(2);
    expect(activityVersion({ ...base, id: "3", type: "read" })).toBeNull();
    expect(activityVersion({ ...base, id: "4", type: "exported", version: 9 })).toBeNull();
  });

  it("labels the surface and groups the filters", () => {
    expect(surfaceLabel("mcp")).toBe("MCP");
    expect(surfaceLabel("api")).toBe("web / API");
    expect(surfaceLabel(undefined)).toBeNull();
    expect(ACTIVITY_FILTERS.find((f) => f.id === "access")!.types).toEqual(["read", "retrieved", "exported"]);
  });
});
