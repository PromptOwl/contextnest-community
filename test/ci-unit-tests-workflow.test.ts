import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

/**
 * The unit tests run in CI (.github/workflows/engine-convergence.yml). These
 * checks keep the job definitions honest: every file runs in one shard, and
 * the tests gated on a real Postgres run in the Postgres job, not nowhere.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = yaml.load(
  readFileSync(join(repoRoot, ".github/workflows/engine-convergence.yml"), "utf8"),
) as any;
const jobs = workflow.jobs;

// Spelled in pieces so this file doesn't match the Postgres job's own search.
const GATE = ["TEST", "DATABASE", "URL"].join("_");

const runOf = (job: any, stepName: string): string =>
  job.steps.find((s: any) => s.name === stepName)?.run ?? "";

/** Every vitest file under a folder, as repo-relative paths. */
function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...testFiles(full));
    else if (/\.test\.tsx?$/.test(name)) found.push(relative(repoRoot, full));
  }
  return found;
}

describe("unit tests in CI", () => {
  it("runs on every pull request", () => {
    expect(workflow.on).toHaveProperty("pull_request");
  });

  it("splits `npm test` into shards whose list matches the total", () => {
    const shards: number[] = jobs.unit.strategy.matrix.shard;
    const run = runOf(jobs.unit, "Run unit tests");
    const total = Number(run.match(/--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/)?.[1]);
    expect(run).toMatch(/^npm test -- /);
    expect(shards).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it("lets every shard finish, so one failure doesn't hide another", () => {
    expect(jobs.unit.strategy["fail-fast"]).toBe(false);
  });

  it("gives the Postgres job a database and points the gated tests at it", () => {
    const pg = jobs["unit-postgres"];
    const service = pg.services.postgres;
    expect(service.image).toMatch(/^postgres:/);
    const url = new URL(pg.env[GATE]);
    expect(url.username).toBe(service.env.POSTGRES_USER);
    expect(url.password).toBe(service.env.POSTGRES_PASSWORD);
    expect(url.pathname.slice(1)).toBe(service.env.POSTGRES_DB);
    expect(service.ports).toContain(`${url.port}:5432`);
  });

  it("runs every test gated on a real Postgres in the Postgres job", () => {
    const run = runOf(jobs["unit-postgres"], "Run the Postgres-gated tests");
    // The job finds its files by searching these folders for the variable.
    const search = run.match(/grep -rl .*'([A-Z_]+)' (.+?) \|/);
    expect(search?.[1]).toBe(GATE);
    const searched = search?.[2].split(" ") ?? [];
    expect(searched).toEqual(["test", "ui/src"]);
    expect(run).toContain("npm test -- $files");
    expect(run).toMatch(/exit 1/); // an empty search fails the job

    const gatedIn = (dirs: string[]) =>
      dirs
        .flatMap((dir) => testFiles(join(repoRoot, dir)))
        .filter((f) => readFileSync(join(repoRoot, f), "utf8").includes(GATE))
        .sort();
    const gated = gatedIn(searched);
    expect(gated).toContain("test/db-postgres.test.ts");
    expect(gated).not.toContain("test/ci-unit-tests-workflow.test.ts");
    // Nothing gated lives where the search doesn't look.
    expect(gatedIn(["test", "ui"])).toEqual(gated);
  });

  it("has one summary job that needs the shards and the Postgres job", () => {
    const all = jobs["unit-all"];
    expect(all.name).toBe("Unit tests");
    expect(all.needs).toEqual(["unit", "unit-postgres"]);
    expect(all.if).toBe("always()");
    const run = runOf(all, "Check every unit test job passed");
    expect(run).toContain('needs.unit.result }}" = "success"');
    expect(run).toContain('needs.unit-postgres.result }}" = "success"');
  });
});
