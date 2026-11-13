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
 * API budget: GITHUB_TOKEN has about 1,000 requests an hour per repo, shared
 * with every workflow. A waiting run costs one list call a poll while any older
 * run is in progress (it is not first in line, nothing else to ask). Only the
 * run at the front of the line reads other runs' jobs, and it stops at the
 * first one past the gate. Polls are 60s by default; a 403/429 waits for the
 * rate-limit reset (or Retry-After) before asking again.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID (set by Actions),
 *      E2E_TURNSTILE_MAX_MINUTES (default 120), E2E_TURNSTILE_POLL_SECONDS (default 60).
 */

import { pathToFileURL } from "node:url";

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

/** An older run is in progress: this one is not first in line. */
export function aheadInLine(selfId, otherIds) {
  return otherIds.some((id) => id < selfId);
}

/**
 * How long to wait after a failed API call: until the rate-limit reset on a
 * 403/429 that says so (or Retry-After), never less than the normal poll.
 * @param {{ status: number, headers: Record<string, string | undefined> }} res
 */
export function rateLimitWaitMs(res, now, pollMs) {
  if (res.status !== 403 && res.status !== 429) return pollMs;
  const retryAfter = Number(res.headers["retry-after"]);
  if (retryAfter > 0) return Math.max(pollMs, retryAfter * 1000);
  const reset = Number(res.headers["x-ratelimit-reset"]);
  if (res.headers["x-ratelimit-remaining"] === "0" && reset > 0) return Math.max(pollMs, reset * 1000 - now);
  return pollMs;
}

/** A positive number from an env value, else the default (stops a 0/NaN poll from spinning). */
export function envNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

class ApiError extends Error {
  constructor(path, res) {
    super(`GitHub API ${path} answered ${res.status}`);
    this.res = { status: res.status, headers: Object.fromEntries(res.headers.entries()) };
  }
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new ApiError(path, res);
  return res.json();
}

/**
 * Other in-progress runs of this workflow. Jobs are read only when this run is
 * first in line, and only until one run is found past the gate.
 */
async function otherRuns(repo, selfId, workflowId) {
  const { workflow_runs: runs = [] } = await gh(`/repos/${repo}/actions/workflows/${workflowId}/runs?status=in_progress&per_page=100`);
  const ids = runs.map((r) => r.id).filter((id) => id !== selfId);
  if (aheadInLine(selfId, ids)) return ids.map((id) => ({ id, gatePassed: false }));
  const out = [];
  for (const id of ids) {
    const { jobs = [] } = await gh(`/repos/${repo}/actions/runs/${id}/jobs?per_page=100`);
    const gatePassed = jobs.some((j) =>
      (j.steps ?? []).some((s) => s.name === GATE_STEP && s.status === "completed" && s.conclusion === "success"),
    );
    out.push({ id, gatePassed });
    if (gatePassed) break;
  }
  return out;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const selfId = Number(process.env.GITHUB_RUN_ID);
  if (!repo || !selfId || !process.env.GITHUB_TOKEN) throw new Error("GITHUB_REPOSITORY, GITHUB_RUN_ID and GITHUB_TOKEN are required");
  const maxMs = envNumber(process.env.E2E_TURNSTILE_MAX_MINUTES, 120) * 60_000;
  const pollMs = Math.max(10, envNumber(process.env.E2E_TURNSTILE_POLL_SECONDS, 60)) * 1000;
  let workflowId;
  const started = Date.now();
  let last = "";
  for (;;) {
    let others;
    let waitMs = pollMs;
    try {
      workflowId ??= (await gh(`/repos/${repo}/actions/runs/${selfId}`)).workflow_id;
      others = await otherRuns(repo, selfId, workflowId);
    } catch (err) {
      // An API error must not let a run through: wait (past a rate-limit
      // reset if that is the cause) and ask again.
      waitMs = err instanceof ApiError ? rateLimitWaitMs(err.res, Date.now(), pollMs) : pollMs;
      console.log(`turnstile: ${err.message}; retrying in ${Math.round(waitMs / 1000)}s`);
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
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
