import { describe, it, expect } from "vitest";
import {
  accountPageForPath,
  accountPageForView,
  accountPages,
  visibleAccountPages,
} from "./account-pages";

// The registry is built from pages/account/*/meta.ts — these guard the
// invariants a new page could break by accident.
describe("account page registry", () => {
  it("finds every page folder and keeps them in sidebar order", () => {
    const ids = accountPages.map((p) => p.id);
    expect(ids).toEqual(["teammates", "settings", "trace", "api-keys", "teams", "guide", "account"]);
    const orders = accountPages.map((p) => p.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("gives every page a unique path and view, none of them the dashboard's", () => {
    const paths = accountPages.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p).toMatch(/^\/[a-z0-9-]+$/);
    const views = accountPages.map((p) => p.viewPage);
    expect(new Set(views).size).toBe(views.length);
  });

  it("maps view → path → page, tolerating a trailing slash", () => {
    for (const p of accountPages) {
      expect(accountPageForPath(accountPageForView(p.viewPage)!.path)?.id).toBe(p.id);
    }
    expect(accountPageForPath("/teams/")?.id).toBe("teams");
    expect(accountPageForPath("/")).toBeUndefined();
    expect(accountPageForPath("/my-work")).toBeUndefined();
  });

  it("lists admin pages only for admins", () => {
    const admin = visibleAccountPages({ isAdmin: true }).map((p) => p.id);
    const member = visibleAccountPages({ isAdmin: false }).map((p) => p.id);
    expect(admin).toEqual(accountPages.map((p) => p.id));
    expect(member).toEqual(["api-keys", "teams", "guide", "account"]);
  });
});
