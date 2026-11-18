import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { decide, GATE_STEP, aheadInLine, rateLimitWaitMs, envNumber } from "../tests/scripts/e2e-turnstile.mjs";

describe("e2e turnstile (one run at a time on the shared server, none dropped)", () => {
  it("goes when no other run is in progress", () => {
    expect(decide(10, [])).toBe("go");
  });

  it("waits while another run is past the gate, whatever its id", () => {
    expect(decide(10, [{ id: 12, gatePassed: true }])).toBe("wait");
    expect(decide(10, [{ id: 8, gatePassed: true }])).toBe("wait");
  });

  it("first come, first served: waits for an older run that has not reached the gate yet", () => {
    expect(decide(10, [{ id: 9, gatePassed: false }])).toBe("wait");
  });

  it("goes ahead of newer runs that are still waiting", () => {
    expect(decide(10, [{ id: 11, gatePassed: false }, { id: 14, gatePassed: false }])).toBe("go");
  });

  it("lets exactly one of several waiting runs go", () => {
    const ids = [21, 22, 23];
    const going = ids.filter((id) => decide(id, ids.filter((o) => o !== id).map((o) => ({ id: o, gatePassed: false }))) === "go");
    expect(going).toEqual([21]);
  });

  it("names the step it looks for in other runs, and the workflow has that step", () => {
    expect(GATE_STEP).toBe("Wait for the shared e2e server");
    const wf = yaml.load(readFileSync(".github/workflows/contextnest-community-tests.yml", "utf8")) as {
      jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
    };
    const step = Object.values(wf.jobs).flatMap((j) => j.steps).find((s) => s.name === GATE_STEP);
    expect(step?.run).toContain("e2e-turnstile.mjs");
  });

  it("falls back to the default for a missing, zero, negative or non-numeric env value", () => {
    expect(envNumber("30", 60)).toBe(30);
    for (const v of [undefined, "", "0", "-5", "abc"]) expect(envNumber(v, 60)).toBe(60);
  });

  it("knows it must wait from the run list alone when an older run is in progress (no per-run jobs calls)", () => {
    expect(aheadInLine(10, [12, 9])).toBe(true);
    expect(aheadInLine(10, [12, 14])).toBe(false);
    expect(aheadInLine(10, [])).toBe(false);
  });

  it("backs off until the rate-limit reset on a 403/429, at least the normal poll", () => {
    const now = 1_000_000_000_000;
    const reset = String(Math.floor(now / 1000) + 300);
    expect(rateLimitWaitMs({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }, now, 60_000)).toBe(300_000);
    expect(rateLimitWaitMs({ status: 429, headers: { "retry-after": "120" } }, now, 60_000)).toBe(120_000);
    expect(rateLimitWaitMs({ status: 429, headers: {} }, now, 60_000)).toBe(60_000);
    expect(rateLimitWaitMs({ status: 500, headers: {} }, now, 60_000)).toBe(60_000);
  });
});

describe("shared-server e2e workflow (tests the deployment, not pull requests)", () => {
  const wf = yaml.load(readFileSync(".github/workflows/contextnest-community-tests.yml", "utf8")) as any;
  const prBuild = yaml.load(readFileSync(".github/workflows/e2e-pr-build.yml", "utf8")) as any;
  const deploy = yaml.load(readFileSync(".github/workflows/deploy-dev.yml", "utf8")) as any;

  it("does not run on pull requests; the PR build does", () => {
    expect(wf.on).not.toHaveProperty("pull_request");
    expect(wf.on).not.toHaveProperty("pull_request_target");
    expect(prBuild.on).toHaveProperty("pull_request");
  });

  it("runs on a merge to development or main, and by hand", () => {
    expect(wf.on.push.branches).toEqual(["main", "development"]);
    expect(wf.on).toHaveProperty("workflow_dispatch");
  });

  it("runs after the dev deploy, named as that workflow names itself, and only when it succeeded", () => {
    expect(wf.on.workflow_run.workflows).toEqual([deploy.name]);
    expect(wf.on.workflow_run.types).toEqual(["completed"]);
    expect(wf.jobs.e2e.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(wf.jobs.e2e.if).toContain("github.event_name != 'workflow_run'");
  });

  it("after a deploy, checks out development (a workflow_run starts on the default branch)", () => {
    const checkout = wf.jobs.e2e.steps.find((s: any) => String(s.uses ?? "").startsWith("actions/checkout@"));
    expect(checkout.with.ref).toContain("github.event_name == 'workflow_run' && 'development'");
    expect(deploy.jobs.deploy.steps.find((s: any) => String(s.uses ?? "").startsWith("actions/checkout@")).with.ref).toBe("development");
  });

  it("never cancels or drops a run: one concurrency group per run, ordered by the turnstile", () => {
    expect(wf.concurrency.group).toBe("e2e-${{ github.run_id }}");
    expect(wf.concurrency["cancel-in-progress"]).toBe(false);
    const names = wf.jobs.e2e.steps.map((s: any) => s.name);
    expect(names.indexOf(GATE_STEP)).toBeGreaterThan(-1);
    expect(names.indexOf(GATE_STEP)).toBeLessThan(names.indexOf("Run Playwright tests"));
  });
});
