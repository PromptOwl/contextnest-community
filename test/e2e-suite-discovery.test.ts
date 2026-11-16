import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSuites, ESTABLISHED_ORDER } from "../tests/src/helper/setup/suite_discovery.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("e2e suite discovery (adding a suite never edits playwright.config.js)", () => {
  let features: string;

  /** Write a file under the temporary features folder, creating its folders. */
  function put(rel: string, body = "") {
    const file = join(features, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }

  beforeEach(() => {
    features = mkdtempSync(join(tmpdir(), "suite-discovery-"));
  });
  afterEach(() => {
    rmSync(features, { recursive: true, force: true });
  });

  it("a folder with a spec is a suite: serial, independent, enabled, with a shortcut project", () => {
    put("billing/billing.spec.js");
    expect(discoverSuites(features, { order: [] })).toEqual([
      {
        name: "billing",
        standalone: true,
        runs: [{ file: "billing/billing.spec.js", mode: "serial", enabled: true, independent: true }],
      },
    ]);
  });

  it("each spec in a folder is its own run, in file-name order, under one suite", () => {
    put("control-room/control_room_setup.spec.js");
    put("control-room/control_room_dashboard.spec.js");
    put("control-room/nested/deep.spec.js");
    const [suite, ...rest] = discoverSuites(features, { order: [] });
    expect(rest).toEqual([]);
    expect(suite.name).toBe("control-room");
    expect(suite.runs.map((r) => r.file)).toEqual([
      "control-room/control_room_dashboard.spec.js",
      "control-room/control_room_setup.spec.js",
      "control-room/nested/deep.spec.js",
    ]);
  });

  it("only *.spec.js files count; a folder without one is not a suite", () => {
    put("helpers/util.js");
    put("notes/README.md");
    put("stray.spec.js"); // a spec outside any suite folder is not picked up
    put("real/real.spec.js");
    put("real/fixture.json", "{}");
    expect(discoverSuites(features, { order: [] }).map((s) => s.name)).toEqual(["real"]);
  });

  it("suite.json overrides the defaults for every spec in the folder", () => {
    put("auth/a.spec.js");
    put("auth/b.spec.js");
    put(
      "auth/suite.json",
      JSON.stringify({ mode: "parallel", independent: false, standalone: false, baseURL: "https://other.example" }),
    );
    const [suite] = discoverSuites(features, { order: [] });
    expect(suite.standalone).toBe(false);
    expect(suite.runs).toEqual([
      { file: "auth/a.spec.js", mode: "parallel", enabled: true, independent: false, baseURL: "https://other.example" },
      { file: "auth/b.spec.js", mode: "parallel", enabled: true, independent: false, baseURL: "https://other.example" },
    ]);
  });

  it("enabled: false is carried on the run so the config leaves it out", () => {
    put("wip/wip.spec.js");
    put("wip/suite.json", JSON.stringify({ enabled: false }));
    expect(discoverSuites(features, { order: [] })[0].runs[0].enabled).toBe(false);
  });

  it("ignored folders are not suites", () => {
    put("global-cleanup/global_cleanup.spec.js");
    put("teams/teams.spec.js");
    expect(discoverSuites(features, { ignore: ["global-cleanup"], order: [] }).map((s) => s.name)).toEqual(["teams"]);
  });

  it("established suites keep their place; new ones follow, by folder name", () => {
    for (const name of ["zebra", "teams", "apple", "auth", "middle"]) put(`${name}/${name}.spec.js`);
    expect(discoverSuites(features, { order: ["auth", "teams"] }).map((s) => s.name)).toEqual([
      "auth",
      "teams",
      "apple",
      "middle",
      "zebra",
    ]);
  });

  it("an established suite that is gone leaves no gap", () => {
    put("teams/teams.spec.js");
    expect(discoverSuites(features, { order: ["auth", "teams"] }).map((s) => s.name)).toEqual(["teams"]);
  });

  it("refuses a suite.json that is not valid JSON, naming the file", () => {
    put("bad/bad.spec.js");
    put("bad/suite.json", "{ mode: parallel");
    expect(() => discoverSuites(features, { order: [] })).toThrow(/bad[\\/]suite\.json is not valid JSON/);
  });

  it("refuses an unknown setting or a wrong value, naming the file", () => {
    put("bad/bad.spec.js");
    put("bad/suite.json", JSON.stringify({ paralel: true }));
    expect(() => discoverSuites(features, { order: [] })).toThrow(/suite\.json sets "paralel"/);

    put("bad/suite.json", JSON.stringify({ mode: "fast" }));
    expect(() => discoverSuites(features, { order: [] })).toThrow(/"mode" must be "serial" or "parallel"/);

    put("bad/suite.json", JSON.stringify({ standalone: "no" }));
    expect(() => discoverSuites(features, { order: [] })).toThrow(/"standalone" must be true or false/);

    put("bad/suite.json", JSON.stringify({ baseURL: "" }));
    expect(() => discoverSuites(features, { order: [] })).toThrow(/"baseURL" must be an http\(s\) URL/);

    put("bad/suite.json", "[]");
    expect(() => discoverSuites(features, { order: [] })).toThrow(/must hold a JSON object/);
  });

  describe("this repo's tests/features", () => {
    const suites = discoverSuites(join(repoRoot, "tests/features"), { ignore: ["global-cleanup"] });
    const names = suites.map((s) => s.name);

    it("yields every established suite first, in its original order", () => {
      expect(names.slice(0, ESTABLISHED_ORDER.length)).toEqual([...ESTABLISHED_ORDER]);
    });

    it("sorts suites added since by folder name", () => {
      const added = names.slice(ESTABLISHED_ORDER.length);
      expect(added).toEqual([...added].sort());
    });

    it("keeps the settings the hand-written list had", () => {
      const byName = Object.fromEntries(suites.map((s) => [s.name, s]));
      expect(byName["auth"].runs).toEqual([
        { file: "auth/email_login.spec.js", mode: "parallel", enabled: true, independent: true },
      ]);
      expect(byName["metacognition"].standalone).toBe(false);
      expect(byName["annotations"].standalone).toBe(false);
      expect(byName["fields"]).toEqual({
        name: "fields",
        standalone: true,
        runs: [{ file: "fields/fields.spec.js", mode: "serial", enabled: true, independent: true }],
      });
    });

    it("never treats the cleanup folder as a suite", () => {
      expect(names).not.toContain("global-cleanup");
    });

    it("playwright.config.js holds no hand-written suite list", () => {
      const config = readFileSync(join(repoRoot, "playwright.config.js"), "utf8");
      expect(config).toContain("discoverSuites(");
      expect(config).not.toMatch(/const standaloneNames = \[/);
      expect(config).not.toMatch(/file: '(?!global-cleanup\/)[\w-]+\/[\w-]+\.spec\.js'/);
    });
  });
});
