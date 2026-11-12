/**
 * Agent control room REST routes (po-1186 CR1).
 *
 * Nest-scoped (mounted under the nestsApp gate, so licence, suspension, nest
 * scope of keys and the read floor are already enforced):
 *   POST /nests/:nestId/agents          register (upsert) an outside agent — owner/admin
 *   GET  /nests/:nestId/ledger          the decision ledger, one page + totals
 *   GET  /nests/:nestId/ledger/export   the same rows, CSV or NDJSON, audited
 *   GET  /nests/:nestId/rollups         day/week × agent/nest/binding rollups
 *
 * Org-wide (mounted at /ledger and /rollups behind flexAuth; read-only):
 *   GET  /ledger, GET /rollups          every nest for a server admin, else the
 *                                       nests the caller owns or administers
 *   GET  /ledger/:entryId               one entry's chain + steps + gaps
 *
 * Every route has a context_agent_* MCP twin over the same service and zod
 * schema (src/mcp/agent-tools.ts). Behind FEATURE_WORKFLOW_PLANE like runs.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "../nodes/engine.js";
import { config } from "../config.js";
import { ForbiddenError, NotFoundError } from "../shared/errors.js";
import { resolveCallerEmail } from "./access-guard.js";
import { resolveNestPermission, permissionLevel } from "../shared/access.js";
import { requireWorkflowPlane } from "../workflow/edge-type-routes.js";
import { LedgerExportQuery, LedgerQuery, RollupsQuery, parseOr422 } from "../workflow/agent-event-schema.js";
import { consumeAgentRate, registerAgent } from "../workflow/agent-events.js";
import { exportLedger, ledgerEntryNest, ledgerTrace, listLedger, nestScope, orgScope } from "./ledger-service.js";
import { rollups } from "./rollup-service.js";
import { recordNodeAccess } from "./access-log.js";

const canSeeDetail = (c: any) => permissionLevel(c.get("nestPermission")) >= permissionLevel("write");

// ─── POST /nests/:nestId/agents ────────────────────────────────────────────

export const agentRegisterRoutes = new Hono<AuthEnv>();
agentRegisterRoutes.post("/", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  // Registering creates a governed document: owner/admin only. The check is on
  // the credential's resolved permission, so an owner's or admin's nest-scoped
  // write key can register (AC-CR-08: an agent registers itself with the key
  // it was given); a key whose user only has write (or read) access can't.
  if (permissionLevel(c.get("nestPermission")) < permissionLevel("admin")) {
    throw new ForbiddenError("Only an owner or admin of this nest can register an agent.");
  }
  const raw = await c.req.json<unknown>().catch(() => ({}));
  const { storage } = await engineCache.get(nestId);
  const out = await registerAgent({
    nestId,
    storage,
    callerEmail: await resolveCallerEmail(c.get("userId")),
    raw,
  });
  return c.json(out, out.created ? 201 : 200);
});

// ─── /nests/:nestId/ledger ─────────────────────────────────────────────────

export const nestLedgerRoutes = new Hono<AuthEnv>();

nestLedgerRoutes.get("/", requireWorkflowPlane, async (c) => {
  consumeAgentRate("reads", { apiKeyId: c.get("apiKeyId"), userId: c.get("userId") });
  const nestId = c.req.param("nestId")!;
  const q = parseOr422(LedgerQuery, c.req.query());
  return c.json(await listLedger(nestScope(nestId, c.get("userId"), canSeeDetail(c)), q));
});

nestLedgerRoutes.get("/export", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  // Validate first: a malformed request is a 422 that spends none of the
  // caller's hourly exports.
  const q = parseOr422(LedgerExportQuery, c.req.query());
  consumeAgentRate("export", { apiKeyId: c.get("apiKeyId"), userId: c.get("userId") });
  const format = q.format ?? "ndjson";
  // The export shows in the nest's activity log (AC-CR-12) — a failed one
  // too, as a failure, so an attempt is never invisible.
  const audit = async (detail: string) =>
    recordNodeAccess({
      nestId,
      wholeNest: true,
      action: "export",
      surface: "api",
      unthrottled: true,
      userId: c.get("userId"),
      userEmail: await resolveCallerEmail(c.get("userId")),
      detail,
    });
  let out: { body: string; rows: number };
  try {
    out = await exportLedger(nestScope(nestId, c.get("userId"), canSeeDetail(c)), q, format);
  } catch (err) {
    await audit(`decision ledger export failed (${format})`).catch(() => {});
    throw err;
  }
  const { body, rows } = out;
  await audit(`decision ledger export (${rows} rows, ${format})`);
  const stamp = new Date().toISOString().slice(0, 10);
  return c.body(body, 200, {
    "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
    "Content-Disposition": `attachment; filename="ledger-${stamp}.${format === "csv" ? "csv" : "ndjson"}"`,
    "X-Ledger-Rows": String(rows),
  });
});

// ─── /nests/:nestId/rollups ────────────────────────────────────────────────

export const nestRollupRoutes = new Hono<AuthEnv>();
nestRollupRoutes.get("/", requireWorkflowPlane, async (c) => {
  consumeAgentRate("reads", { apiKeyId: c.get("apiKeyId"), userId: c.get("userId") });
  const nestId = c.req.param("nestId")!;
  const q = parseOr422(RollupsQuery, c.req.query());
  return c.json(await rollups(nestScope(nestId, c.get("userId"), canSeeDetail(c)), q, `/nests/${nestId}/ledger`));
});

// ─── Org-wide: /ledger, /ledger/:entryId, /rollups ────────────────────────

async function orgScopeFor(c: any) {
  return orgScope(c.get("userId"), {
    keyNestScope: c.get("nestScope") ?? null,
    readOnlyKey: c.get("keyCapability") === "read",
  });
}

export const orgLedgerRoutes = new Hono<AuthEnv>();

orgLedgerRoutes.get("/", requireWorkflowPlane, async (c) => {
  consumeAgentRate("reads", { apiKeyId: c.get("apiKeyId"), userId: c.get("userId") });
  const q = parseOr422(LedgerQuery, c.req.query());
  return c.json(await listLedger(await orgScopeFor(c), q));
});

// GET /ledger/:entryId — one entry's chain. Sits outside the nestsApp gate,
// so it re-does the gate's checks the way loadRunWithPermission does: a
// nest-scoped key stays in its nest, and no read access is a 404 (no oracle).
orgLedgerRoutes.get("/:entryId", requireWorkflowPlane, async (c) => {
  consumeAgentRate("reads", { apiKeyId: c.get("apiKeyId"), userId: c.get("userId") });
  const entryId = c.req.param("entryId")!;
  const nestId = await ledgerEntryNest(entryId);
  if (!nestId) throw new NotFoundError("Ledger entry not found");
  const keyNest = c.get("nestScope");
  if (keyNest && keyNest !== nestId) throw new ForbiddenError("API key not authorized for this nest");
  const perm = config.AUTH_MODE === "open" ? "owner" : await resolveNestPermission(nestId, c.get("userId"));
  if (permissionLevel(perm) < permissionLevel("read")) throw new NotFoundError("Ledger entry not found");
  const detail = permissionLevel(perm) >= permissionLevel("write") && c.get("keyCapability") !== "read";
  return c.json(await ledgerTrace(nestScope(nestId, c.get("userId"), detail), entryId));
});

export const orgRollupRoutes = new Hono<AuthEnv>();
orgRollupRoutes.get("/", requireWorkflowPlane, async (c) => {
  consumeAgentRate("reads", { apiKeyId: c.get("apiKeyId"), userId: c.get("userId") });
  const q = parseOr422(RollupsQuery, c.req.query());
  return c.json(await rollups(await orgScopeFor(c), q, "/ledger"));
});
