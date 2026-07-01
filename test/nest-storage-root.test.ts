import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { resolveNestPath, nestStorageRoot } from "../src/shared/paths.js";
import { config } from "../src/config.js";

/**
 * The nest storage root is the single seam that lets nest files live somewhere
 * other than `<DATA_ROOT>/nests` (e.g. a GCS volume mount on Cloud Run) while
 * the DB stays on DATA_ROOT. These tests pin both the back-compat default and
 * the override behaviour. config getters read process.env on each access, so
 * mutating env between tests is enough — no module reset needed.
 */
describe("nest storage root", () => {
  let savedDataRoot: string | undefined;
  let savedNestRoot: string | undefined;

  beforeEach(() => {
    savedDataRoot = process.env.DATA_ROOT;
    savedNestRoot = process.env.NEST_STORAGE_ROOT;
    delete process.env.NEST_STORAGE_ROOT;
  });

  afterEach(() => {
    if (savedDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = savedDataRoot;
    if (savedNestRoot === undefined) delete process.env.NEST_STORAGE_ROOT;
    else process.env.NEST_STORAGE_ROOT = savedNestRoot;
  });

  it("defaults to <DATA_ROOT>/nests when NEST_STORAGE_ROOT is unset", () => {
    process.env.DATA_ROOT = join("/srv", "cn-data");
    expect(nestStorageRoot()).toBe(join("/srv", "cn-data", "nests"));
    expect(resolveNestPath("abc")).toBe(join("/srv", "cn-data", "nests", "abc"));
  });

  it("honours NEST_STORAGE_ROOT override, independent of DATA_ROOT", () => {
    process.env.DATA_ROOT = join("/srv", "cn-data");
    process.env.NEST_STORAGE_ROOT = "/mnt/nests";
    expect(config.NEST_STORAGE_ROOT).toBe("/mnt/nests");
    expect(nestStorageRoot()).toBe("/mnt/nests");
    expect(resolveNestPath("abc")).toBe(join("/mnt/nests", "abc"));
  });

  it("keeps the DB path on DATA_ROOT when nests are moved off it", () => {
    process.env.DATA_ROOT = join("/srv", "cn-data");
    process.env.NEST_STORAGE_ROOT = "/mnt/nests";
    delete process.env.DATABASE_PATH;
    // nests on the mount, DB still under DATA_ROOT — the whole point of the seam
    expect(resolveNestPath("n1")).toBe(join("/mnt/nests", "n1"));
    expect(config.DATABASE_PATH).toBe(join("/srv", "cn-data", "community.db"));
  });
});
