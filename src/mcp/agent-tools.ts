/**
 * MCP twins of the agent control room REST routes (po-1186 CR1, AC-CR-09).
 *
 * Same service functions, same zod schemas (src/workflow/agent-event-schema.ts):
 * each tool's input schema is GENERATED from the schema its REST route
 * validates with, so the two can't drift and no inline schema literal is
 * added here (lint:mcp-schemas).
 *
 *   context_agent_register       POST /nests/:id/agents            owner/admin
 *   context_agent_run_start      POST /nests/:id/run/:agent        write (report_only default true)
 *   context_agent_run_step       POST /runs/:id/steps              write
 *   context_agent_run_close      PATCH /runs/:id                   write
 *   context_agent_ledger         GET /nests/:id/ledger             read
 *   context_agent_ledger_trace   GET /ledger/:entryId              read
 *   context_agent_ledger_export  GET /nests/:id/ledger/export      read (a page of NDJSON + cursor)
 *   context_agent_rollups        GET /nests/:id/rollups            read
 *   context_agent_ledger_org     GET /ledger                       server-level MCP
 *   context_agent_rollups_org    GET /rollups                      server-level MCP
 *
 * The per-nest MCP endpoint sits behind the nestsApp gate (licence,
 * suspension, key nest scope); each tool here adds its own tier check, since
 * the gate admits read-tier callers to MCP.
 */
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { resolveNestPermission, permissionLevel, type NestPermission } from "../shared/access.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../shared/errors.js";
import type { McpToolContext } from "./tools.js";
import {
  AGENT_MCP_INPUTS,
  type AgentMcpTool,
  mcpInputSchema,
  parseIdempotencyKey,
  parseOr422,
} from "../workflow/agent-event-schema.js";
import {
  assertExternalWriteCredential,
  closeRunIdempotent,
  consumeAgentRate,
  registerAgent,
  startReportRun,
} from "../workflow/agent-events.js";
import { appendRunStep, loadRun, triggerRun } from "../workflow/run-service.js";
import { SERVER_CLAIM } from "../metacognition/store.js";
import { ledgerEntryNest, ledgerTrace, listLedger, nestScope, orgScope } from "../governance/ledger-service.js";
import { rollups } from "../governance/rollup-service.js";
import { recordNodeAccess } from "../governance/access-log.js";

const DESCRIPTIONS: Record<AgentMcpTool, string> = {
  context_agent_register:
    "Register an outside agent (Claude Code, a script, a fleet member) as an agent node in this nest, so its runs show in the decision ledger. Upsert: an existing agent with that node_id is returned with created: false. Owner/admin only.",
  context_agent_run_start:
    "Start a run for a registered agent. report_only (default true) records that the agent ran without building an executable bundle; set report_only: false to get the bundle as workflow_run does. Pass idempotency_key so a retry never creates a second run. External reports need a nest-scoped API key.",
  context_agent_run_step:
    "Record one step of a run. Typed actions: decision {verdict: no_op|propose|act|escalate, reason_code, summary (<=280 chars, your own words), evidence [{kind, ref}] (<=10, references only)}, proposal {review_id} for a review you opened (links it to the run), outcome {kind, ref, status}. Never put message text in a step. idempotency_key makes a retry safe.",
  context_agent_run_close:
    "Close a run: succeeded | failed | cancelled, with optional usage {input_tokens, output_tokens}, est_cost_usd and a one-line summary. Repeating the same close is an idempotent replay; a different status after close is a conflict.",
  context_agent_ledger:
    "List this nest's decision ledger: one row per agent decision (including decisions to do nothing), with its run, verdict, proposal, review, saved version and source, plus totals for the range. Filter by from/to, agent, verdict, state, source, binding, q; page with cursor.",
  context_agent_ledger_trace:
    "Trace one ledger entry: its full chain (run → verdict → proposal → review → saved version → source), the run's steps, and gaps: the hops it should have and doesn't.",
  context_agent_ledger_export:
    "Export ledger rows as NDJSON, one page at a time (same filters and redaction as context_agent_ledger). Returns {ndjson, next_cursor}; call again with the cursor for more. Each call is recorded in the nest's access log.",
  context_agent_rollups:
    "Count this nest's decision ledger by day or ISO week, grouped by agent, nest, binding or none: runs, no-ops, proposals and their outcomes, cost and tokens. Every bucket matches the ledger totals for the same range.",
  context_agent_ledger_org:
    "List the decision ledger across nests: every nest for a server admin, otherwise the nests you own or administer. Same filters and redaction as context_agent_ledger; nest_id narrows to one.",
  context_agent_rollups_org:
    "Count the decision ledger across the nests you administer (every nest for a server admin). Same parameters as context_agent_rollups; nest_id narrows to one.",
};

const def = (name: AgentMcpTool) => ({
  name,
  description: DESCRIPTIONS[name],
  inputSchema: mcpInputSchema(AGENT_MCP_INPUTS[name]),
});

/** Per-nest tools (registered with the workflow tools, FEATURE_WORKFLOW_PLANE). */
export const AGENT_TOOL_DEFINITIONS = (
  [
    "context_agent_register",
    "context_agent_run_start",
    "context_agent_run_step",
    "context_agent_run_close",
    "context_agent_ledger",
    "context_agent_ledger_trace",
    "context_agent_ledger_export",
    "context_agent_rollups",
  ] as const
).map(def);

/** Server-level (/mcp) org-wide reads. */
export const AGENT_ORG_TOOL_DEFINITIONS = (["context_agent_ledger_org", "context_agent_rollups_org"] as const).map(def);

export const AGENT_READ_TOOL_NAMES = [
  "context_agent_ledger",
  "context_agent_ledger_trace",
  "context_agent_ledger_export",
  "context_agent_rollups",
  "context_agent_ledger_org",
  "context_agent_rollups_org",
];
export const AGENT_ADMIN_TOOL_NAMES = ["context_agent_register"];

/** The REST route each tool twins (the AC-CR-09 parity table). */
export const AGENT_TOOL_REST: Record<AgentMcpTool, string> = {
  context_agent_register: "POST /nests/:nestId/agents",
  context_agent_run_start: "POST /nests/:nestId/run/:agent",
  context_agent_run_step: "POST /runs/:id/steps",
  context_agent_run_close: "PATCH /runs/:id",
  context_agent_ledger: "GET /nests/:nestId/ledger",
  context_agent_ledger_trace: "GET /ledger/:entryId",
  context_agent_ledger_export: "GET /nests/:nestId/ledger/export",
  context_agent_rollups: "GET /nests/:nestId/rollups",
  context_agent_ledger_org: "GET /ledger",
  context_agent_rollups_org: "GET /rollups",
};

const PER_NEST = new Set<string>(AGENT_TOOL_DEFINITIONS.map((t) => t.name));
const ORG = new Set<string>(AGENT_ORG_TOOL_DEFINITIONS.map((t) => t.name));
export const isAgentTool = (name: string): boolean => PER_NEST.has(name);
export const isAgentOrgTool = (name: string): boolean => ORG.has(name);

const json = (v: unknown): string => JSON.stringify(v, null, 2);

async function permOf(ctx: McpToolContext): Promise<NestPermission> {
  const perm = config.AUTH_MODE === "open" ? "owner" : await resolveNestPermission(ctx.nestId, ctx.userId);
  // A read-only key reads, whatever its owner may do (same clamp as REST).
  return ctx.capability === "read" && permissionLevel(perm) > permissionLevel("read") ? "read" : perm;
}

function requireTier(perm: NestPermission, tier: "read" | "write" | "admin"): void {
  if (permissionLevel(perm) < permissionLevel(tier)) {
    throw new ForbiddenError(tier === "admin" ? "Only an owner or admin of this nest can register an agent." : `This action needs ${tier} access to the nest.`);
  }
}

async function loadNestRun(ctx: McpToolContext, runId: unknown) {
  const run = typeof runId === "string" && runId ? await loadRun(runId) : undefined;
  // A run in another nest is "not found" to a caller scoped to this one.
  if (!run || run.nest_id !== ctx.nestId) throw new NotFoundError("Run not found");
  return run as typeof run & { claimed_by?: string | null; source?: string | null };
}

/** Dispatch for the per-nest context_agent_* tools. Returns the JSON result. */
export async function runAgentTool(toolName: string, args: Record<string, any>, ctx: McpToolContext): Promise<string> {
  const perm = await permOf(ctx);
  const who = { apiKeyId: ctx.apiKeyId ?? null, userId: ctx.userId };
  const detail = permissionLevel(perm) >= permissionLevel("write");
  switch (toolName) {
    case "context_agent_register": {
      requireTier(perm, "admin");
      const svc = (await getDb().get("SELECT is_service FROM users WHERE id = ?", [ctx.userId])) as { is_service: number | null } | undefined;
      if (svc?.is_service) throw new ForbiddenError("A service or system identity can't register agents.");
      return json(
        await registerAgent({ nestId: ctx.nestId, storage: ctx.storage, callerEmail: await resolveCallerEmail(ctx.userId), raw: stripClient(args) }),
      );
    }
    case "context_agent_run_start": {
      requireTier(perm, "write");
      consumeAgentRate("runs", who);
      const input = parseOr422(AGENT_MCP_INPUTS.context_agent_run_start, stripClient(args));
      const key = parseIdempotencyKey(input.idempotency_key);
      const triggeredBy = await resolveCallerEmail(ctx.userId);
      if (input.report_only === false) {
        return json(
          await triggerRun({
            nestId: ctx.nestId,
            agentNode: input.agent,
            inputs: input.inputs,
            triggeredBy,
            storage: ctx.storage,
            parentRunId: input.parent_run_id,
            userId: ctx.userId,
            idempotencyKey: key,
            externalRef: input.external_ref ?? null,
          }),
        );
      }
      await assertExternalWriteCredential({ nestId: ctx.nestId, apiKeyId: ctx.apiKeyId ?? null, requireKey: true });
      return json(
        await startReportRun({
          nestId: ctx.nestId,
          agentNode: input.agent,
          storage: ctx.storage,
          triggeredBy,
          inputs: input.inputs,
          startedAt: input.started_at,
          externalRef: input.external_ref,
          idempotencyKey: key,
        }),
      );
    }
    case "context_agent_run_step": {
      requireTier(perm, "write");
      consumeAgentRate("events", who);
      const input = parseOr422(AGENT_MCP_INPUTS.context_agent_run_step, stripClient(args));
      const run = await loadNestRun(ctx, input.run_id);
      if (run.claimed_by === SERVER_CLAIM) {
        throw new ConflictError("This run is executed by the server; its steps are recorded by the server");
      }
      if (run.source === "external") {
        await assertExternalWriteCredential({ nestId: ctx.nestId, apiKeyId: ctx.apiKeyId ?? null, requireKey: true });
      }
      const out = await appendRunStep(run.id, input, { clientKey: parseIdempotencyKey(input.idempotency_key) });
      return json({ ok: true, run_id: run.id, ...out });
    }
    case "context_agent_run_close": {
      requireTier(perm, "write");
      const input = parseOr422(AGENT_MCP_INPUTS.context_agent_run_close, stripClient(args));
      const run = await loadNestRun(ctx, input.run_id);
      if (run.claimed_by === SERVER_CLAIM && input.status !== "cancelled") {
        throw new ConflictError("This run is executed by the server — it can be cancelled, not closed");
      }
      if (run.source === "external") {
        await assertExternalWriteCredential({ nestId: ctx.nestId, apiKeyId: ctx.apiKeyId ?? null, requireKey: true });
      }
      const { run_id: _r, ...body } = input;
      return json({ ok: true, run_id: run.id, ...(await closeRunIdempotent(run.id, body)) });
    }
    case "context_agent_ledger": {
      requireTier(perm, "read");
      consumeAgentRate("reads", who);
      const q = parseOr422(AGENT_MCP_INPUTS.context_agent_ledger, stripClient(args));
      return json(await listLedger(nestScope(ctx.nestId, ctx.userId, detail), q));
    }
    case "context_agent_ledger_trace": {
      requireTier(perm, "read");
      consumeAgentRate("reads", who);
      const { entry_id } = parseOr422(AGENT_MCP_INPUTS.context_agent_ledger_trace, stripClient(args));
      if ((await ledgerEntryNest(entry_id)) !== ctx.nestId) throw new NotFoundError("Ledger entry not found");
      return json(await ledgerTrace(nestScope(ctx.nestId, ctx.userId, detail), entry_id));
    }
    case "context_agent_ledger_export": {
      requireTier(perm, "read");
      // Validate before spending an export (as REST does); audit a failure too.
      const q = parseOr422(AGENT_MCP_INPUTS.context_agent_ledger_export, stripClient(args));
      consumeAgentRate("export", who);
      const audit = (detail: string) =>
        recordNodeAccess({
          nestId: ctx.nestId,
          wholeNest: true,
          action: "export",
          surface: "mcp",
          unthrottled: true,
          userId: ctx.userId,
          userEmail: ctx.userEmail,
          client: ctx.client,
          detail,
        });
      let page;
      try {
        page = await listLedger(nestScope(ctx.nestId, ctx.userId, detail), { ...q, limit: q.limit ?? 200 }, { totals: false });
      } catch (err) {
        audit("decision ledger export failed (ndjson)");
        throw err;
      }
      audit(`decision ledger export (${page.entries.length} rows, ndjson)`);
      return json({
        api_version: page.api_version,
        rows: page.entries.length,
        ndjson: page.entries.map((e) => JSON.stringify(e)).join("\n"),
        next_cursor: page.next_cursor,
      });
    }
    case "context_agent_rollups": {
      requireTier(perm, "read");
      consumeAgentRate("reads", who);
      const q = parseOr422(AGENT_MCP_INPUTS.context_agent_rollups, stripClient(args));
      return json(await rollups(nestScope(ctx.nestId, ctx.userId, detail), q, `/nests/${ctx.nestId}/ledger`));
    }
    default:
      return json({ error: `Unknown agent tool: ${toolName}` });
  }
}

/** `client` (caller attribution) rides on every tool call; the read schemas don't name it. */
function stripClient(args: Record<string, any>): Record<string, any> {
  const { client: _c, confirm_billing: _b, ...rest } = args ?? {};
  return rest;
}

/** Dispatch for the server-level org tools (GET /ledger, GET /rollups twins). */
export async function runAgentOrgTool(
  toolName: string,
  args: Record<string, any>,
  ctx: { userId: string; apiKeyId: string | null; nestScope: string | null; capability: "read" | "write" },
): Promise<string> {
  if (!config.FEATURE_WORKFLOW_PLANE) {
    return "The workflow plane is not enabled on this server. An admin can turn it on with FEATURE_WORKFLOW_PLANE=true.";
  }
  consumeAgentRate("reads", { apiKeyId: ctx.apiKeyId, userId: ctx.userId });
  if (toolName === "context_agent_ledger_org") {
    const { nest_id, ...q } = parseOr422(AGENT_MCP_INPUTS.context_agent_ledger_org, stripClient(args));
    const scope = await orgScope(ctx.userId, { keyNestScope: ctx.nestScope, readOnlyKey: ctx.capability === "read", onlyNest: nest_id });
    return json(await listLedger(scope, q));
  }
  if (toolName === "context_agent_rollups_org") {
    const { nest_id, ...q } = parseOr422(AGENT_MCP_INPUTS.context_agent_rollups_org, stripClient(args));
    const scope = await orgScope(ctx.userId, { keyNestScope: ctx.nestScope, readOnlyKey: ctx.capability === "read", onlyNest: nest_id });
    return json(await rollups(scope, q, "/ledger"));
  }
  return json({ error: `Unknown agent tool: ${toolName}` });
}
