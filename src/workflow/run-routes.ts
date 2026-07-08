/**
 * Runs — the operational trace of the workflow plane ("turing" track).
 *
 * The server never executes anything: an external runner (Hootie, Claude, a
 * Temporal worker) calls POST /run/<agent> and receives the full executable
 * BUNDLE in one round-trip — agent instructions, the flow-edge subgraph
 * reachable from it, and every definition its structured conditions reference.
 * The runner walks the edges, appends a step per action, and closes the run.
 * Because retrieval is deterministic (selector+hops), a recorded run replays
 * to the identical read-set.
 *
 * This file is the HTTP surface only: it resolves auth/permission and delegates
 * every data operation to run-service.ts, which the MCP tools share so the two
 * surfaces can't drift. Feature-flagged like the rest of the plane.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "../nodes/engine.js";
import { config } from "../config.js";
import { AppError, NotFoundError, ForbiddenError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { resolveNestPermission, permissionLevel } from "../shared/access.js";
import { isSuspended, getSuspensionReason, getCurrentLicense } from "../auth/license.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { requireWorkflowPlane } from "./edge-type-routes.js";
import {
  loadRun,
  triggerRun,
  appendRunStep,
  closeRun,
  getRunTrace,
  listRuns,
  type RunRow,
} from "./run-service.js";

// ─── Nest-scoped routes: trigger + list ─────────────────────────────────

export const runTriggerRoutes = new Hono<AuthEnv>();
// Gate PER ROUTE, not via `use("*", …)`: this router mounts under
// `/nests/:nestId/run`, so a wildcard middleware flattens to
// `/nests/:nestId/run/*` — combined with the `:agentNode{.+}` route below that
// yields a path carrying BOTH a `:label`/regex param AND a `*`, which the app's
// LinearRouter (chosen for multi-segment node ids) rejects with
// UnsupportedPathError, wedging the WHOLE app on the first request. Mirrors the
// same fix in edge-routes / edge-type-routes.

// POST /nests/:nestId/run/:agentNode{.+}
runTriggerRoutes.post("/:agentNode{.+}", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  // SECURITY: the catch-all param can carry `../` — validate before it reaches
  // storage.readDocument, or a caller with write on nest A reads nest B's
  // agent bodies via `..%2FB%2Fnodes%2Fsecret`. (See src/shared/node-id.ts.)
  const agentNode = assertSafeNodeId(c.req.param("agentNode")!);
  const body = await c.req
    .json<{ inputs?: unknown; parent_run_id?: unknown }>()
    .catch(() => ({}) as { inputs?: unknown; parent_run_id?: unknown });

  const { storage } = await engineCache.get(nestId);
  // Derived from auth, never client-supplied — this is the accountability
  // field ("who triggered this run"), so it must be trustworthy. A scheduler
  // or external runner authenticates with its own key; that identity is the
  // honest answer.
  const triggeredBy = await resolveCallerEmail(c.get("userId"));

  const bundle = await triggerRun({
    nestId,
    agentNode,
    inputs: body.inputs,
    triggeredBy,
    storage,
    parentRunId: body.parent_run_id,
  });
  return c.json(bundle, 201);
});

// GET /nests/:nestId/runs?agent=&status=&limit=
export const runListRoutes = new Hono<AuthEnv>();
runListRoutes.get("/", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  // The nestsApp gate already resolved the caller's permission into
  // `nestPermission`; reuse it for the read-tier redaction rather than
  // re-querying.
  const canSeeDetail =
    permissionLevel((c as any).get("nestPermission")) >=
    permissionLevel("write");
  const result = await listRuns(nestId, {
    agent: c.req.query("agent") || undefined,
    status: c.req.query("status") || undefined,
    limit: Number(c.req.query("limit")) || undefined,
    canSeeDetail,
  });
  return c.json(result);
});

// ─── Top-level /runs/:id routes (runner-facing) ─────────────────────────
// Auth: resolve the run's nest, then enforce nest permission — write for
// stepping/closing, read for viewing (with NL rationale redacted at read
// tier, same posture as changes-since deleted[]).

export const runDetailRoutes = new Hono<AuthEnv>();
// Per-route gate (not `use("*")`) for the same LinearRouter reason as above:
// this router mounts at top-level `/runs`, and a wildcard would flatten to
// `/runs/*` alongside `/runs/:id` — a `:label` + `*` collision that wedges the
// app. Attach requireWorkflowPlane to each route instead.

async function loadRunWithPermission(
  c: any,
  runId: string,
  required: "read" | "write",
): Promise<RunRow> {
  const run = await loadRun(runId);
  if (!run) throw new NotFoundError("Run not found");

  // These /runs/:id routes sit OUTSIDE the nestsApp gate, so the checks that
  // gate does for every other nest-scoped route must be replicated here —
  // otherwise a nest-scoped key (or a suspended/unlicensed server) could act
  // on runs it shouldn't. This route family is the one handed to external
  // runners, so the guarantee matters most here. STATUS CODES MIRROR THE GATE
  // exactly (app.ts): scope mismatch 403, suspension/license 503, unknown-nest
  // (no permission) 404 to hide existence — so a runner keying off the status
  // reads the same signal here as on every other nest route.
  const nestScope = c.get("nestScope");
  if (nestScope && nestScope !== run.nest_id) {
    // Mirror the nest gate's 403 + message so scoped keys fail the same way.
    throw new ForbiddenError("API key not authorized for this nest");
  }
  if (required === "write") {
    if (isSuspended()) {
      throw new AppError(503, `Server suspended by PromptOwl: ${getSuspensionReason()}`);
    }
    if (!getCurrentLicense()?.valid) {
      throw new AppError(503, "A valid PromptOwl license is required to write runs.");
    }
  }

  const perm =
    config.AUTH_MODE === "open"
      ? "owner"
      : await resolveNestPermission(run.nest_id, c.get("userId"));
  // No access at all → 404, same as the gate (permission "none" ⇒ "Nest not
  // found"): don't leak that the run/nest exists. Has-read-but-needs-write ⇒
  // 403, since that caller already legitimately sees the run.
  if (perm === "none") {
    throw new NotFoundError("Run not found");
  }
  if (permissionLevel(perm) < permissionLevel(required)) {
    throw new ForbiddenError(
      `This run belongs to a nest where you lack ${required} access.`,
    );
  }
  (c as any).set("runPermission", perm);
  return run;
}

// POST /runs/:id/steps
runDetailRoutes.post("/:id/steps", requireWorkflowPlane, async (c) => {
  const run = await loadRunWithPermission(c, c.req.param("id")!, "write");
  const body = await c.req.json<Record<string, unknown>>();
  const { seq } = await appendRunStep(run.id, body);
  return c.json({ ok: true, seq }, 201);
});

// PATCH /runs/:id — close or update status/trace
runDetailRoutes.patch("/:id", requireWorkflowPlane, async (c) => {
  const run = await loadRunWithPermission(c, c.req.param("id")!, "write");
  const body = await c.req.json<Record<string, unknown>>();
  const { status } = await closeRun(run.id, body);
  return c.json({ ok: true, status });
});

// GET /runs/:id — full trace; NL rationales redacted below write tier.
runDetailRoutes.get("/:id", requireWorkflowPlane, async (c) => {
  const run = await loadRunWithPermission(c, c.req.param("id")!, "read");
  const canSeeDetail =
    permissionLevel((c as any).get("runPermission")) >=
    permissionLevel("write");
  const result = await getRunTrace(run, { canSeeDetail });
  return c.json(result);
});
