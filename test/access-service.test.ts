/**
 * Access service tests — access.yaml parsing + ABAC rules.
 *
 * The access service holds module-level state (accessConfig). Each test
 * reloads the module via vi.resetModules() and points DATA_ROOT at a
 * fresh tmpdir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type AccessModule = typeof import("../src/governance/access-service.js");

let dataDir: string;

async function loadAccessModule(): Promise<AccessModule> {
  vi.resetModules();
  process.env.DATA_ROOT = dataDir;
  return await import("../src/governance/access-service.js");
}

function writeAccessYaml(content: string): void {
  writeFileSync(join(dataDir, "access.yaml"), content, "utf-8");
}

describe("loadAccessConfig", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "access-"));
    mkdirSync(dataDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns null when no access.yaml exists", async () => {
    const mod = await loadAccessModule();
    expect(mod.loadAccessConfig()).toBeNull();
    expect(mod.getAccessConfig()).toBeNull();
  });

  it("loads access.yaml from DATA_ROOT", async () => {
    writeAccessYaml(`mode: restricted
allowed_users:
  - alice@acme.com
  - "*.acme.com"
super_admins:
  - admin@acme.com
`);
    const mod = await loadAccessModule();
    const cfg = mod.loadAccessConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.mode).toBe("restricted");
    expect(cfg!.allowed_users).toEqual(["alice@acme.com", "*.acme.com"]);
    expect(cfg!.super_admins).toEqual(["admin@acme.com"]);
  });

  it("falls back to access.yml when access.yaml is absent", async () => {
    writeFileSync(
      join(dataDir, "access.yml"),
      "mode: restricted\nsuper_admins:\n  - root@acme.com\n",
      "utf-8",
    );
    const mod = await loadAccessModule();
    const cfg = mod.loadAccessConfig();
    expect(cfg!.super_admins).toEqual(["root@acme.com"]);
  });

  it("parses groups with members + default_permission", async () => {
    writeAccessYaml(`groups:
  engineering:
    default_permission: write
    members:
      - alice@acme.com
      - bob@acme.com
  viewers:
    default_permission: read
    members:
      - "*.contractor.com"
`);
    const mod = await loadAccessModule();
    const cfg = mod.loadAccessConfig()!;
    expect(cfg.groups).toBeDefined();
    expect(cfg.groups!.engineering.default_permission).toBe("write");
    expect(cfg.groups!.engineering.members).toEqual([
      "alice@acme.com",
      "bob@acme.com",
    ]);
    expect(cfg.groups!.viewers.default_permission).toBe("read");
    expect(cfg.groups!.viewers.members).toEqual(["*.contractor.com"]);
  });

  it("ignores comment lines and blank lines", async () => {
    writeAccessYaml(`# this is a comment
mode: restricted

# trailing comment
allowed_users:
  # inline
  - alice@acme.com
`);
    const mod = await loadAccessModule();
    const cfg = mod.loadAccessConfig()!;
    expect(cfg.allowed_users).toEqual(["alice@acme.com"]);
  });

  it("strips quotes from list values", async () => {
    writeAccessYaml(`super_admins:
  - "alice@acme.com"
  - 'bob@acme.com'
`);
    const mod = await loadAccessModule();
    const cfg = mod.loadAccessConfig()!;
    expect(cfg.super_admins).toEqual(["alice@acme.com", "bob@acme.com"]);
  });
});

describe("isEmailAllowed", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "access-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("allows everyone when no config is loaded", async () => {
    const mod = await loadAccessModule();
    expect(mod.isEmailAllowed("anyone@anywhere.com")).toBe(true);
  });

  it("allows everyone when mode is not 'restricted'", async () => {
    writeAccessYaml("mode: open\nallowed_users:\n  - alice@acme.com\n");
    const mod = await loadAccessModule();
    mod.loadAccessConfig();
    expect(mod.isEmailAllowed("anyone@anywhere.com")).toBe(true);
  });

  it("matches exact email entries (case-insensitive)", async () => {
    writeAccessYaml("mode: restricted\nallowed_users:\n  - alice@acme.com\n");
    const mod = await loadAccessModule();
    mod.loadAccessConfig();
    expect(mod.isEmailAllowed("alice@acme.com")).toBe(true);
    expect(mod.isEmailAllowed("ALICE@ACME.COM")).toBe(true);
    expect(mod.isEmailAllowed("bob@acme.com")).toBe(false);
  });

  it("matches *.domain wildcards on email domain", async () => {
    writeAccessYaml(`mode: restricted
allowed_users:
  - "*.acme.com"
`);
    const mod = await loadAccessModule();
    mod.loadAccessConfig();
    expect(mod.isEmailAllowed("anyone@acme.com")).toBe(true);
    expect(mod.isEmailAllowed("eve@evil.com")).toBe(false);
  });

  it("allows everyone when restricted mode has no allowed_users list", async () => {
    writeAccessYaml("mode: restricted\n");
    const mod = await loadAccessModule();
    mod.loadAccessConfig();
    expect(mod.isEmailAllowed("anyone@anywhere.com")).toBe(true);
  });
});

describe("getGroupsForUser + getDefaultPermission", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "access-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns groups for a user matched by exact email", async () => {
    writeAccessYaml(`groups:
  engineering:
    default_permission: write
    members:
      - alice@acme.com
  viewers:
    default_permission: read
    members:
      - alice@acme.com
`);
    const mod = await loadAccessModule();
    mod.loadAccessConfig();
    expect(mod.getGroupsForUser("alice@acme.com").sort()).toEqual([
      "engineering",
      "viewers",
    ]);
  });

  it("returns groups matched by wildcard membership", async () => {
    writeAccessYaml(`groups:
  acme_staff:
    default_permission: write
    members:
      - "*.acme.com"
`);
    const mod = await loadAccessModule();
    mod.loadAccessConfig();
    expect(mod.getGroupsForUser("anyone@acme.com")).toEqual(["acme_staff"]);
    expect(mod.getGroupsForUser("eve@evil.com")).toEqual([]);
  });

  it("returns [] when no groups are defined", async () => {
    const mod = await loadAccessModule();
    expect(mod.getGroupsForUser("alice@acme.com")).toEqual([]);
  });

  it("getDefaultPermission picks the highest permission across matching groups", async () => {
    writeAccessYaml(`groups:
  basic:
    default_permission: read
    members:
      - alice@acme.com
  admins:
    default_permission: admin
    members:
      - alice@acme.com
  writers:
    default_permission: write
    members:
      - alice@acme.com
`);
    const mod = await loadAccessModule();
    mod.loadAccessConfig();
    expect(mod.getDefaultPermission("alice@acme.com")).toBe("admin");
  });

  it("getDefaultPermission returns null when user matches no group", async () => {
    writeAccessYaml(`groups:
  staff:
    default_permission: write
    members:
      - alice@acme.com
`);
    const mod = await loadAccessModule();
    mod.loadAccessConfig();
    expect(mod.getDefaultPermission("bob@acme.com")).toBeNull();
  });

  it("getDefaultPermission returns null when no groups configured", async () => {
    const mod = await loadAccessModule();
    expect(mod.getDefaultPermission("alice@acme.com")).toBeNull();
  });
});

describe("isSuperAdmin", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "access-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns false when no config is loaded", async () => {
    const mod = await loadAccessModule();
    expect(mod.isSuperAdmin("alice@acme.com")).toBe(false);
  });

  it("returns false when super_admins list is empty / absent", async () => {
    writeAccessYaml("mode: restricted\n");
    const mod = await loadAccessModule();
    mod.loadAccessConfig();
    expect(mod.isSuperAdmin("alice@acme.com")).toBe(false);
  });

  it("matches super_admins case-insensitively", async () => {
    writeAccessYaml("super_admins:\n  - admin@acme.com\n");
    const mod = await loadAccessModule();
    mod.loadAccessConfig();
    expect(mod.isSuperAdmin("admin@acme.com")).toBe(true);
    expect(mod.isSuperAdmin("ADMIN@ACME.COM")).toBe(true);
    expect(mod.isSuperAdmin("alice@acme.com")).toBe(false);
  });
});
