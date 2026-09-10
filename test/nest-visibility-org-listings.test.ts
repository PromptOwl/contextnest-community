/**
 * Listing coverage for the `org` visibility tier.
 *
 * `listVisibleNests({readable})` and `listPublicNests` both build their
 * visibility filter as a dynamic `?` placeholder list, which is exactly the
 * shape where a param-count mismatch throws at runtime instead of compile
 * time. These assertions are the guard for that.
 *
 * Deliberately DB-level rather than app-level: these two functions are the
 * whole surface under test, and driving them directly avoids booting the
 * engine (see nest-visibility-org.test.ts, which does need the app).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

let dataDir: string;
let listPublicNests: typeof import("../src/nests/service.js")["listPublicNests"];
let listVisibleNests: typeof import("../src/nests/service.js")["listVisibleNests"];
let ANON: string;

const OWNER = "user-owner";
const STRANGER = "user-stranger";

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), `vis-org-${randomUUID()}-`));
  process.env.DATA_ROOT = dataDir;
  process.env.DATABASE_PATH = join(dataDir, "test.db");
  process.env.DB_DRIVER = "sqlite";
  process.env.AUTH_MODE = "key"; // open mode would fold every caller into anon
  process.env.PROMPTOWL_KEY = "";
  process.env.TELEMETRY_ENABLED = "false";
  delete process.env.DATABASE_URL;

  const client = await import("../src/db/client.js");
  await client.initDb();
  const svc = await import("../src/nests/service.js");
  listPublicNests = svc.listPublicNests;
  listVisibleNests = svc.listVisibleNests;
  ANON = (await import("../src/shared/constants.js")).ANON_USER_ID;

  const db = client.getDb();
  for (const [id, email] of [
    [OWNER, "owner@acme.test"],
    [STRANGER, "stranger@acme.test"],
  ]) {
    await db.run("INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)", [
      id,
      email,
      email.split("@")[0],
      "x",
    ]);
  }
  const nest = async (id: string, slug: string, visibility: string) =>
    db.run(
      "INSERT INTO nests (id, user_id, name, slug, visibility) VALUES (?,?,?,?,?)",
      [id, OWNER, slug, slug, visibility],
    );
  await nest("nest-private", "priv", "private");
  await nest("nest-org", "org", "org");
  await nest("nest-public", "pub", "public");
});

afterAll(async () => {
  const client = await import("../src/db/client.js");
  await client.resetDb();
  rmSync(dataDir, { recursive: true, force: true });
});

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

describe("listPublicNests", () => {
  it("offers an org nest to an authenticated non-member", async () => {
    expect(ids(await listPublicNests(STRANGER))).toEqual(["nest-org", "nest-public"]);
  });

  it("offers only the public nest to an anonymous caller", async () => {
    expect(ids(await listPublicNests(ANON))).toEqual(["nest-public"]);
  });

  it("never offers a private nest", async () => {
    expect(ids(await listPublicNests(STRANGER))).not.toContain("nest-private");
  });
});

describe("listVisibleNests({ readable: true })", () => {
  it("includes an org nest for an authenticated non-member", async () => {
    expect(ids(await listVisibleNests(STRANGER, { readable: true }))).toEqual([
      "nest-org",
      "nest-public",
    ]);
  });

  it("excludes the org nest for an anonymous caller", async () => {
    expect(ids(await listVisibleNests(ANON, { readable: true }))).toEqual(["nest-public"]);
  });

  it("without `readable`, visibility alone grants nothing", async () => {
    expect(ids(await listVisibleNests(STRANGER))).toEqual([]);
  });

  it("still returns the owner their own nests", async () => {
    expect(ids(await listVisibleNests(OWNER))).toEqual([
      "nest-org",
      "nest-private",
      "nest-public",
    ]);
  });
});

/**
 * The server-admin path is the one that appends an extra `?` AFTER the
 * visibility list (the anon-owned OR), so it is where a param-count mismatch
 * would actually surface.
 */
describe("listVisibleNests({ readable: true }) as a server admin", () => {
  let loadGrantedSuperAdmins: () => Promise<void>;

  beforeAll(async () => {
    const client = await import("../src/db/client.js");
    const db = client.getDb();
    ({ loadGrantedSuperAdmins } = await import(
      "../src/governance/access-service.js"
    ));
    await db.run(
      "INSERT OR IGNORE INTO users (id, email, name, password_hash) VALUES (?,?,?,?)",
      [ANON, "anon@local", "anon", "x"],
    );
    await db.run(
      "INSERT INTO nests (id, user_id, name, slug, visibility) VALUES (?,?,?,?,?)",
      ["nest-anon", ANON, "anon", "anon", "private"],
    );
    await db.run(
      "INSERT INTO super_admins (email, granted_by) VALUES (?, ?)",
      ["stranger@acme.test", "owner@acme.test"],
    );
    await loadGrantedSuperAdmins();
  });

  afterAll(async () => {
    const client = await import("../src/db/client.js");
    await client.getDb().run("DELETE FROM super_admins");
    await loadGrantedSuperAdmins();
  });

  it("sees org + public by visibility AND the anon-owned commons", async () => {
    expect(ids(await listVisibleNests(STRANGER, { readable: true }))).toEqual([
      "nest-anon",
      "nest-org",
      "nest-public",
    ]);
  });
});
