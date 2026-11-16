import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assertWritable, DataDirError } from "../src/shared/data-dir-check.js";

// Root ignores permission bits, and on Windows chmod can't make a directory
// read-only, so the refusal cases only mean something as non-root on POSIX.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
const noPerms = asRoot || process.platform === "win32";

describe("assertWritable (boot check for the data directory)", () => {
  let base: string;
  const locked: string[] = [];
  const lock = (p: string, mode = 0o555) => {
    chmodSync(p, mode);
    locked.push(p);
  };
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "cn-datadir-"));
  });
  afterEach(() => {
    for (const p of locked.splice(0)) chmodSync(p, 0o755);
    rmSync(base, { recursive: true, force: true });
  });

  it("passes, and creates a missing directory, when it is writable", () => {
    const dir = join(base, "data", "nests");
    expect(() => assertWritable([{ label: "NEST_STORAGE_ROOT", path: dir }])).not.toThrow();
  });

  it("passes for a database file that doesn't exist yet in a writable directory", () => {
    expect(() =>
      assertWritable([{ label: "DATABASE_PATH", path: join(base, "db", "community.db"), file: true }]),
    ).not.toThrow();
  });

  it.skipIf(noPerms)("refuses a read-only directory and names the path and the chown fix", () => {
    const dir = join(base, "data");
    mkdirSync(dir);
    lock(dir);
    expect(() => assertWritable([{ label: "DATA_ROOT", path: dir }])).toThrow(
      new RegExp(`DATA_ROOT ${dir} is not writable[\\s\\S]*chown -R[\\s\\S]*SKIP_DATA_DIR_CHECK=1`),
    );
    expect(() => assertWritable([{ label: "DATA_ROOT", path: dir }])).toThrow(DataDirError);
  });

  it("returns null when everything is writable", () => {
    expect(assertWritable([{ label: "NEST_STORAGE_ROOT", path: join(base, "nests"), children: true }])).toBeNull();
  });

  it.skipIf(noPerms)("warns, without refusing to boot, on a read-only nest under a writable root", () => {
    const nest = join(base, "nests", "abc");
    mkdirSync(nest, { recursive: true });
    lock(nest);
    const warning = assertWritable([{ label: "NEST_STORAGE_ROOT", path: join(base, "nests"), children: true }]);
    expect(warning).toMatch(new RegExp(`NEST_STORAGE_ROOT ${nest} is not writable[\\s\\S]*chown -R`));
  });

  it.skipIf(noPerms)("ignores read-only entries in a directory checked without children (a mounted access.yaml)", () => {
    const dir = join(base, "data");
    mkdirSync(dir);
    const access = join(dir, "access.yaml");
    writeFileSync(access, "");
    lock(access, 0o444);
    expect(() => assertWritable([{ label: "DATA_ROOT", path: dir }])).not.toThrow();
  });

  it.skipIf(noPerms)("refuses a root-owned SQLite -wal file beside a writable database", () => {
    const db = join(base, "community.db");
    writeFileSync(db, "");
    writeFileSync(`${db}-wal`, "");
    lock(`${db}-wal`, 0o444);
    expect(() => assertWritable([{ label: "DATABASE_PATH", path: db, file: true }])).toThrow(
      /community\.db-wal is not writable/,
    );
  });

  it.skipIf(noPerms)("refuses a database file the user can't write", () => {
    const db = join(base, "community.db");
    writeFileSync(db, "");
    lock(db, 0o444);
    expect(() => assertWritable([{ label: "DATABASE_PATH", path: db, file: true }])).toThrow(
      /DATABASE_PATH .*community\.db is not writable/,
    );
  });

  it.skipIf(noPerms)("refuses a writable database file in a read-only directory (SQLite needs -wal beside it)", () => {
    const dir = join(base, "db");
    mkdirSync(dir);
    const db = join(dir, "community.db");
    writeFileSync(db, "");
    lock(dir);
    expect(() => assertWritable([{ label: "DATABASE_PATH", path: db, file: true }])).toThrow(
      new RegExp(`DATABASE_PATH ${dir} is not writable`),
    );
  });

  it.skipIf(noPerms)("checks at most 50 children, so boot cost doesn't grow with the nest count", () => {
    const root = join(base, "nests");
    for (let i = 0; i < 60; i++) {
      const d = join(root, `n${i}`);
      mkdirSync(d, { recursive: true });
      lock(d);
    }
    // 60 unwritable nests, 50 checked, 5 listed: "…and 45 more".
    expect(assertWritable([{ label: "NEST_STORAGE_ROOT", path: root, children: true }])).toMatch(/…and 45 more/);
  });

  it.skipIf(noPerms)("lists at most five paths and summarises the rest", () => {
    const root = join(base, "nests");
    for (let i = 0; i < 7; i++) {
      const d = join(root, `n${i}`);
      mkdirSync(d, { recursive: true });
      lock(d);
    }
    expect(assertWritable([{ label: "NEST_STORAGE_ROOT", path: root, children: true }])).toMatch(/…and 2 more/);
  });
});
