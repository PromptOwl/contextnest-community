import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assertWritable } from "../src/shared/data-dir-check.js";

// Root ignores permission bits, so the refusal cases only mean something as non-root.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

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

  it.skipIf(asRoot)("refuses a read-only directory and names the path and the chown fix", () => {
    const dir = join(base, "data");
    mkdirSync(dir);
    lock(dir);
    expect(() => assertWritable([{ label: "DATA_ROOT", path: dir }])).toThrow(
      new RegExp(`DATA_ROOT ${dir} is not writable[\\s\\S]*chown -R`),
    );
  });

  it.skipIf(asRoot)("refuses a writable directory whose child is read-only (top-level-only chown)", () => {
    const nest = join(base, "nests", "abc");
    mkdirSync(nest, { recursive: true });
    lock(nest);
    expect(() =>
      assertWritable([{ label: "NEST_STORAGE_ROOT", path: join(base, "nests"), children: true }]),
    ).toThrow(new RegExp(`NEST_STORAGE_ROOT ${nest} is not writable`));
  });

  it.skipIf(asRoot)("ignores read-only entries in a directory checked without children (a mounted access.yaml)", () => {
    const dir = join(base, "data");
    mkdirSync(dir);
    const access = join(dir, "access.yaml");
    writeFileSync(access, "");
    lock(access, 0o444);
    expect(() => assertWritable([{ label: "DATA_ROOT", path: dir }])).not.toThrow();
  });

  it.skipIf(asRoot)("refuses a root-owned SQLite -wal file beside a writable database", () => {
    const db = join(base, "community.db");
    writeFileSync(db, "");
    writeFileSync(`${db}-wal`, "");
    lock(`${db}-wal`, 0o444);
    expect(() => assertWritable([{ label: "DATABASE_PATH", path: db, file: true }])).toThrow(
      /community\.db-wal is not writable/,
    );
  });

  it.skipIf(asRoot)("refuses a database file the user can't write", () => {
    const db = join(base, "community.db");
    writeFileSync(db, "");
    lock(db, 0o444);
    expect(() => assertWritable([{ label: "DATABASE_PATH", path: db, file: true }])).toThrow(
      /DATABASE_PATH .*community\.db is not writable/,
    );
  });

  it.skipIf(asRoot)("refuses a writable database file in a read-only directory (SQLite needs -wal beside it)", () => {
    const dir = join(base, "db");
    mkdirSync(dir);
    const db = join(dir, "community.db");
    writeFileSync(db, "");
    lock(dir);
    expect(() => assertWritable([{ label: "DATABASE_PATH", path: db, file: true }])).toThrow(
      new RegExp(`DATABASE_PATH ${dir} is not writable`),
    );
  });

  it.skipIf(asRoot)("lists at most five paths and summarises the rest", () => {
    const root = join(base, "nests");
    for (let i = 0; i < 7; i++) {
      const d = join(root, `n${i}`);
      mkdirSync(d, { recursive: true });
      lock(d);
    }
    expect(() => assertWritable([{ label: "NEST_STORAGE_ROOT", path: root, children: true }])).toThrow(
      /…and 2 more/,
    );
  });
});
