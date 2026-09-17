import { describe, it, expect } from "vitest";
import {
  DEFAULT_PAGE_ID,
  dashboardPage,
  dashboardPageIdFromPath,
  dashboardPages,
  dashboardPath,
} from "./pages";

// The registry is built from pages/dashboard/*/meta.ts — these guard the
// invariants a new page could break by accident.
describe("dashboard page registry", () => {
  it("finds every page folder and keeps them in sidebar order", () => {
    const ids = dashboardPages.map((p) => p.id);
    expect(ids).toEqual(["nests", "my-work", "my-drafts", "account"]);
    const orders = dashboardPages.map((p) => p.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("gives every page a unique path and exactly one page the root", () => {
    const paths = dashboardPages.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter((p) => p === "/")).toHaveLength(1);
    for (const p of paths) expect(p).toMatch(/^\/[a-z0-9-]*$/);
  });

  it("maps id → path → id, tolerating a trailing slash", () => {
    for (const p of dashboardPages) {
      expect(dashboardPageIdFromPath(dashboardPath(p.id))).toBe(p.id);
    }
    expect(dashboardPageIdFromPath("/my-work/")).toBe("my-work");
    expect(dashboardPageIdFromPath("/")).toBe(DEFAULT_PAGE_ID);
  });

  it("is null for nest and unknown paths, and falls back to the default page", () => {
    expect(dashboardPageIdFromPath("/nest/abc")).toBeNull();
    expect(dashboardPageIdFromPath("/my-work/extra")).toBeNull();
    expect(dashboardPage("no-such-page").id).toBe(DEFAULT_PAGE_ID);
    expect(dashboardPage(undefined).id).toBe(DEFAULT_PAGE_ID);
  });
});
