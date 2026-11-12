#!/usr/bin/env node
/**
 * E2E turnstile: one e2e run at a time against the shared deployed server,
 * without dropping queued runs.
 *
 * Why not a workflow `concurrency` group: GitHub keeps at most ONE pending run
 * per group and cancels the older pending one when another arrives. With one
 * repo-wide group (e2e-<TEST_URL>) every PR shared that single slot, so with
 * three or more PRs pushing, most e2e runs were cancelled before they started.
 *
 * Instead each run waits here, after checkout and install (which don't touch
 * the server), until it may go:
 *   - no other in-progress run of this workflow is past this step, and
 *   - no other in-progress run is older (lower run id) — first come, first
 *     served, so a run that is still installing keeps its place.
 * Exactly one waiting run sees "go" at a time (run ids are unique).
 *
 * Needs `actions: read` and GITHUB_TOKEN. Pure Node 20, no dependencies.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID (set by Actions),
 *      E2E_TURNSTILE_MAX_MINUTES (default 120), E2E_TURNSTILE_POLL_SECONDS (default 20).
 */

/** Name of the workflow step that runs this script; other runs are read by it. */
export const GATE_STEP = "Wait for the shared e2e server";

/**
 * @param {number} selfId this run's id
 * @param {{ id: number, gatePassed: boolean }[]} others other in-progress runs of this workflow
 * @returns {"go" | "wait"}
 */
export function decide(selfId, others) {
  if (others.some((r) => r.gatePassed)) return "wait";
  if (others.some((r) => r.id < selfId)) return "wait";
  return "go";
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} answered ${res.status}`);
  return res.json();
}

/** Other in-progress runs of this workflow, and whether each is past the gate. */
async function otherRuns(repo, selfId, workflowId) {
  const { workflow_runs: runs = [] } = await gh(`/repos/${repo}/actions/workflows/${workflowId}/runs?status=in_progress&per_page=100`);
  const out = [];
  for (const run of runs) {
    if (run.id === selfId) continue;
    const { jobs = [] } = await gh(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    const gatePassed = jobs.some((j) =>
      (j.steps ?? []).some((s) => s.name === GATE_STEP && s.status === "completed" && s.conclusion === "success"),
    );
    out.push({ id: run.id, gatePassed });
  }
  return out;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const selfId = Number(process.env.GITHUB_RUN_ID);
  if (!repo || !selfId || !process.env.GITHUB_TOKEN) throw new Error("GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_TOKEN are required");
  const maxMs = Number(process.env.E2E_TURNSTILE_MAX_MINUTES ?? 120) * 60_000;
  const pollMs = Number(process.env.E2E_TURNSTILE_POLL_SECONDS ?? 20) * 1000;
  const { workflow_id: workflowId } = await gh(`/repos/${repo}/actions/runs/${selfId}`);
  const started = Date.now();
  let last = "";
  for (;;) {
    let others;
    try {
      others = await otherRuns(repo, selfId, workflowId);
    } catch (err) {
      // A transient API error must not let a run through: wait and ask again.
      console.log(`turnstile: ${err.message}; retrying`);
      others = null;
    }
    if (others && decide(selfId, others) === "go") {
      console.log(`turnstile: run ${selfId} goes (waited ${Math.round((Date.now() - started) / 1000)}s)`);
      return;
    }
    const line = others
      ? `waiting on ${others.filter((r) => r.gatePassed || r.id < selfId).map((r) => `${r.id}${r.gatePassed ? " (running e2e)" : " (ahead in line)"}`).join(", ")}`
      : "waiting (API error)";
    if (line !== last) console.log(`turnstile: run ${selfId} ${line}`);
    last = line;
    if (Date.now() - started > maxMs) throw new Error(`turnstile: waited more than ${maxMs / 60_000} minutes for the shared e2e server`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
