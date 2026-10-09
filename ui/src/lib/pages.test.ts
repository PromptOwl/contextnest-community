import { describe, it, expect } from "vitest";
import {
  DEFAULT_PAGE_ID,
  appPage,
  appPageIdFromPath,
  appPages,
  appPath,
  appRail,
  PAGE_GROUPS,
  visibleAppPage,
} from "./pages";

// The registry is built from pages/app/*/meta.ts — these guard the
// invariants a new page could break by accident.
describe("dashboard page registry", () => {
  it("finds every page folder and keeps them in sidebar order", () => {
    const ids = appPages.map((p) => p.id);
    expect(ids).toEqual([
      "nests", "my-work", "my-drafts",
      "teams", "api-keys", "connected-apps",
      "teammates", "settings", "trace",
      "guide", "account",
    ]);
    const orders = appPages.map((p) => p.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("gives every page a unique path and exactly one page the root", () => {
    const paths = appPages.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter((p) => p === "/")).toHaveLength(1);
    for (const p of paths) expect(p).toMatch(/^\/[a-z0-9-]*$/);
  });

  it("maps id → path → id, tolerating a trailing slash", () => {
    for (const p of appPages) {
      expect(appPageIdFromPath(appPath(p.id))).toBe(p.id);
    }
    expect(appPageIdFromPath("/my-work/")).toBe("my-work");
    expect(appPageIdFromPath("/")).toBe(DEFAULT_PAGE_ID);
  });

  it("is null for nest and unknown paths, and falls back to the default page", () => {
    expect(appPageIdFromPath("/nest/abc")).toBeNull();
    expect(appPageIdFromPath("/my-work/extra")).toBeNull();
    expect(appPage("no-such-page").id).toBe(DEFAULT_PAGE_ID);
    expect(appPage(undefined).id).toBe(DEFAULT_PAGE_ID);
  });
});

describe("dashboard rail groups", () => {
  it("puts every grouped page in a known group, Nests alone on top", () => {
    const groupIds = PAGE_GROUPS.map((g) => g.id) as string[];
    for (const p of appPages) if (p.group) expect(groupIds).toContain(p.group);
    expect(appRail({ isAdmin: true }).top.map((p) => p.id)).toEqual(["nests"]);
  });

  it("shows the Admin group to admins only and keeps Account out of the rail", () => {
    const admin = appRail({ isAdmin: true });
    const member = appRail({ isAdmin: false });
    expect(admin.groups.map((g) => g.id)).toEqual(["work", "workspace", "admin", "help"]);
    expect(member.groups.map((g) => g.id)).toEqual(["work", "workspace", "help"]);
    const listed = [...admin.top, ...admin.groups.flatMap((g) => g.pages)].map((p) => p.id);
    expect(listed).not.toContain("account");
    expect(appPageIdFromPath("/account")).toBe("account");
  });

  it("resolves a gated page to the default for a member, itself for an admin", () => {
    expect(visibleAppPage("settings", { isAdmin: true }).id).toBe("settings");
    expect(visibleAppPage("settings", { isAdmin: false }).id).toBe(DEFAULT_PAGE_ID);
    expect(visibleAppPage("teams", { isAdmin: false }).id).toBe("teams");
  });

  it("lists Connected apps only while MCP agent sign-in is on", () => {
    const ids = (caps: Parameters<typeof appRail>[0]) =>
      appRail(caps).groups.flatMap((g) => g.pages).map((p) => p.id);
    expect(ids({ isAdmin: false })).not.toContain("connected-apps");
    expect(ids({ isAdmin: false, mcpOauthEnabled: true })).toContain("connected-apps");
    expect(visibleAppPage("connected-apps", { isAdmin: false }).id).toBe(DEFAULT_PAGE_ID);
    expect(visibleAppPage("connected-apps", { isAdmin: false, mcpOauthEnabled: true }).id).toBe(
      "connected-apps",
    );
  });
});
