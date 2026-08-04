import { describe, it, expect } from "vitest";
import { activityTimestamp } from "../ui/src/lib/node-sort";

describe("activityTimestamp", () => {
  it("returns the later of edit and comment timestamps", () => {
    expect(activityTimestamp("2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z")).toBe(
      "2026-08-02T00:00:00Z",
    );
    expect(activityTimestamp("2026-08-03T00:00:00Z", "2026-08-02T00:00:00Z")).toBe(
      "2026-08-03T00:00:00Z",
    );
  });
  it("ignores a missing side", () => {
    expect(activityTimestamp(null, "2026-08-02T00:00:00Z")).toBe(
      "2026-08-02T00:00:00Z",
    );
    expect(activityTimestamp("2026-08-01T00:00:00Z", null)).toBe(
      "2026-08-01T00:00:00Z",
    );
    expect(activityTimestamp(undefined, undefined)).toBe("");
  });
  it("sorts a list descending by activity (newest first)", () => {
    const rows = [
      { id: "a", updated_at: "2026-08-01T00:00:00Z", lastAt: null },
      { id: "b", updated_at: "2026-07-01T00:00:00Z", lastAt: "2026-08-05T00:00:00Z" },
      { id: "c", updated_at: "2026-08-03T00:00:00Z", lastAt: "2026-08-02T00:00:00Z" },
    ];
    const order = [...rows]
      .sort((x, y) =>
        activityTimestamp(y.updated_at, y.lastAt).localeCompare(
          activityTimestamp(x.updated_at, x.lastAt),
        ),
      )
      .map((r) => r.id);
    expect(order).toEqual(["b", "c", "a"]);
  });
});
