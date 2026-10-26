import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { assertWritable } from "../src/shared/data-dir-check.js";

// Root ignores permission bits, so the refusal cases only mean something as non-root.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("assertWritable (boot check for the data directory)", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "cn-datadir-"));
  });
  afterEach(() => {
    chmodSync(base, 0o755);
    rmSync(base, { recursive: true, force: true });
  });

  it("passes, and creates a missing directory, when it is writable", () => {
    const dir = join(base, "data", "nests");
    expect(() => assertWritable([{ label: "NEST_STORAGE_ROOT", path: dir }])).not.toThrow();
  });

  it("ignores a database file that doesn't exist yet", () => {
    expect(() =>
      assertWritable([{ label: "DATABASE_PATH", path: join(base, "community.db"), file: true }]),
    ).not.toThrow();
  });

  it.skipIf(asRoot)("refuses a read-only directory and names the path and the chown fix", () => {
    const dir = join(base, "data");
    mkdirSync(dir);
    chmodSync(dir, 0o555);
    try {
      expect(() => assertWritable([{ label: "DATA_ROOT", path: dir }])).toThrow(
        new RegExp(`DATA_ROOT ${dir} is not writable[\\s\\S]*chown -R`),
      );
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it.skipIf(asRoot)("refuses a database file the user can't write", () => {
    const db = join(base, "community.db");
    writeFileSync(db, "");
    chmodSync(db, 0o444);
    expect(() => assertWritable([{ label: "DATABASE_PATH", path: db, file: true }])).toThrow(
      /DATABASE_PATH .* is not writable/,
    );
  });
});
