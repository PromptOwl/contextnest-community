/**
 * Agent event API (po-1186 CR1): the one set of zod schemas the REST routes
 * and the MCP tools both validate with. MCP tool input schemas are generated
 * from these objects (`mcpInputSchema`), so the two surfaces can't drift —
 * AC-CR-09's parity test asserts it.
 *
 * Typed run steps (`decision`, `proposal`, `outcome`) are strict: an unknown
 * key, a summary over 280 characters or more than 10 evidence refs is a 422
 * that names the field (AC-CR-08d). No field carries message text: `summary`
 * is the agent's own sentence about its conclusion, `evidence` holds
 * references, never quotes.
 */
import { z } from "zod";
import { CodedError } from "../shared/errors.js";

/** Every agent event API response carries this (api-contract §6). */
export const AGENT_API_VERSION = "2026-11";

/** Idempotency-Key header / `idempotency_key` argument. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
export const IdempotencyKey = z
  .string()
  .regex(IDEMPOTENCY_KEY_RE, "must be 1-128 characters of A-Z a-z 0-9 . _ : -")
  .describe(
    "Optional idempotency key (1-128 chars, A-Za-z0-9._:-). Repeating a call with the same key returns the original result with idempotent_replay: true and writes nothing; the same key with a different body is a 409 idempotency_conflict.",
  );

const SNAKE = /^[a-z0-9_]{1,40}$/;

// ─── Typed step details ────────────────────────────────────────────────────

export const DECISION_VERDICTS = ["no_op", "propose", "act", "escalate"] as const;

export const EvidenceRef = z
  .strictObject({
    kind: z.string().regex(/^[a-z_]{1,20}$/, "must be a short snake_case word, e.g. node | url | run | review"),
    ref: z.string().min(1).max(2048),
  })
  // A url ref is rendered as a link in the control room: http(s) only, so a
  // `javascript:` or `data:` ref can't ride into the UI.
  .refine((e) => e.kind !== "url" || /^https?:\/\/[^\s]+$/i.test(e.ref), { message: "a url ref must be an http(s) URL", path: ["ref"] });

export const DecisionDetail = z.strictObject({
  verdict: z.enum(DECISION_VERDICTS),
  reason_code: z.string().regex(SNAKE, "must be snake_case, at most 40 characters"),
  summary: z.string().max(280).optional(),
  evidence: z.array(EvidenceRef).max(10).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export const ProposalDetail = z.strictObject({
  review_id: z.string().min(1).max(200),
  node_id: z.string().min(1).max(500).optional(),
});

export const OutcomeDetail = z.strictObject({
  kind: z.string().regex(SNAKE, "must be snake_case, at most 40 characters"),
  ref: z.string().min(1).max(2048).optional(),
  status: z.enum(["ok", "failed", "skipped"]).optional(),
});

/** The typed step actions and the schema each one's `detail` must satisfy. */
export const TYPED_STEP_DETAIL = {
  decision: DecisionDetail,
  proposal: ProposalDetail,
  outcome: OutcomeDetail,
} as const;
export type TypedStepAction = keyof typeof TYPED_STEP_DETAIL;
export const isTypedStepAction = (a: string): a is TypedStepAction =>
  Object.prototype.hasOwnProperty.call(TYPED_STEP_DETAIL, a);

// ─── Request bodies (REST) ─────────────────────────────────────────────────

/** POST /nests/:nestId/agents (E1). */
export const AgentRegisterBody = z.strictObject({
  node_id: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Node id for the agent (e.g. nodes/agents/claude-code-misha). Default: nodes/agents/<slug of name>."),
  name: z.string().trim().min(1).max(120).describe("The agent's display name."),
  description: z.string().max(1000).optional().describe("What the agent does, in a sentence or two."),
  runtime: z
    .string()
    .regex(/^[a-z0-9_-]{1,40}$/, "must be a short label, e.g. claude-code | hootie | custom")
    .optional()
    .describe("Free label for where it runs: claude-code | hootie | clara | marketing-fleet | custom."),
  owner: z.string().email().max(320).optional().describe("Email of the person accountable for it; must be on the nest. Default: the caller."),
  executes: z.enum(["external", "runner", "server"]).optional().describe("Where it executes. Default external."),
});

/** POST /nests/:nestId/run/:agent (E2) — new optional fields beside inputs / parent_run_id. */
export const AgentRunStartBody = z.object({
  inputs: z.unknown().optional().describe("Optional caller inputs recorded on the run."),
  parent_run_id: z.unknown().optional().describe("Optional: spawn as a sub-agent run under a running parent (FEATURE_SUBAGENT_RUNS)."),
  report_only: z.boolean().optional().describe("true: record a run without building the executable bundle (an agent reporting what it did)."),
  started_at: z.iso
    .datetime({ offset: true })
    .optional()
    .describe("When the run actually started (ISO 8601). At most 24 h in the past, never in the future. Default now."),
  external_ref: z.string().min(1).max(200).optional().describe("The caller's own id for this run (e.g. a session id). Shown, never trusted."),
});

/** POST /runs/:id/steps (E3). Typed actions validate `detail` separately. */
export const AgentRunStepBody = z.object({
  action: z
    .string()
    .min(1)
    .max(40)
    .describe("read | write | branch | notify | external, or a typed action: decision | proposal | outcome."),
  node_id: z.string().max(500).optional().describe("Node the step touched (optional)."),
  edge_id: z.string().max(200).optional().describe("Edge the step followed (optional)."),
  detail: z
    .unknown()
    .optional()
    .describe(
      'Step payload. decision: {verdict: no_op|propose|act|escalate, reason_code, summary? (<=280), evidence? [{kind, ref}] (<=10), confidence?}. proposal: {review_id, node_id?}. outcome: {kind, ref?, status?: ok|failed|skipped}. Never message text.',
    ),
});

/** PATCH /runs/:id (E4). */
export const AgentRunCloseBody = z.object({
  status: z.enum(["running", "succeeded", "failed", "cancelled"]).describe("succeeded | failed | cancelled (or running to update the trace)."),
  trace: z.record(z.string(), z.unknown()).optional().describe("Optional summary object recorded on the run."),
  usage: z
    .record(z.string(), z.number().nonnegative())
    .optional()
    .describe("Token usage, e.g. {input_tokens, output_tokens}. Stored in the trace; rolls up like metacognition runs."),
  est_cost_usd: z.number().nonnegative().max(100000).optional().describe("Estimated cost of the run in USD."),
  summary: z.string().max(280).optional().describe("One sentence on what the run concluded."),
});

// ─── Read queries ──────────────────────────────────────────────────────────

export const LEDGER_VERDICTS = ["no_op", "propose", "act", "escalate", "error"] as const;
export const LEDGER_STATES = ["pending", "approved", "edited", "rejected", "expired", "withdrawn"] as const;
export const LEDGER_SOURCES = ["surfaces", "metacognition", "runner", "external"] as const;

const LedgerFilters = {
  from: z.iso.datetime({ offset: true }).optional().describe("Range start (ISO 8601, inclusive). Default 7 days ago."),
  to: z.iso.datetime({ offset: true }).optional().describe("Range end (ISO 8601, exclusive). Default now."),
  agent: z.string().max(500).optional().describe("Only this agent node id."),
  verdict: z.enum(LEDGER_VERDICTS).optional().describe("no_op | propose | act | escalate | error"),
  state: z.enum(LEDGER_STATES).optional().describe("Rows with a proposal in this state: pending | approved | edited | rejected | expired | withdrawn"),
  source: z.enum(LEDGER_SOURCES).optional().describe("surfaces | metacognition | runner | external"),
  binding: z.string().max(200).optional().describe("Only this Surfaces binding (channel)."),
};

export const LedgerQuery = z.object({
  ...LedgerFilters,
  q: z.string().max(200).optional().describe("Search proposal titles. Private-nest rows never match."),
  cursor: z.string().max(500).optional().describe("next_cursor from the previous page."),
  limit: z.coerce.number().int().min(1).max(200).optional().describe("Rows per page, 1-200 (default 50)."),
});

export const LedgerExportQuery = LedgerQuery.extend({
  format: z.enum(["csv", "ndjson"]).optional().describe("csv | ndjson (default ndjson)."),
});

export const LedgerTraceInput = z.object({
  entry_id: z.string().min(1).max(200).describe("entry_id from the ledger: win_<window id> or run_<run id>."),
});

export const RollupsQuery = z.object({
  ...LedgerFilters,
  grain: z.enum(["day", "week"]).optional().describe("day | week (ISO weeks, UTC; bucket = the Monday). Default day."),
  by: z
    .enum(["agent", "nest", "binding", "reason", "none"])
    .optional()
    .describe("agent | nest | binding | reason (the verdict's reason_code) | none. Default agent."),
});

// ─── MCP inputs (REST body + the path/header parts) ────────────────────────

const RUN_ID = z.string().min(1).max(200).describe("Run id, from context_agent_run_start.");
const NEST_ID = z.string().min(1).max(200).optional().describe("Limit to one nest you administer.");

export const AGENT_MCP_INPUTS = {
  context_agent_register: AgentRegisterBody,
  context_agent_run_start: AgentRunStartBody.extend({
    agent: z.string().min(1).max(500).describe("Node id of the registered agent (type agent or skill)."),
    report_only: z.boolean().optional().describe("Default true over MCP: record the run, no bundle. false: also return the executable bundle."),
    idempotency_key: IdempotencyKey.optional(),
  }),
  context_agent_run_step: AgentRunStepBody.extend({ run_id: RUN_ID, idempotency_key: IdempotencyKey.optional() }),
  context_agent_run_close: AgentRunCloseBody.extend({ run_id: RUN_ID }),
  context_agent_ledger: LedgerQuery,
  context_agent_ledger_trace: LedgerTraceInput,
  context_agent_ledger_export: LedgerQuery,
  context_agent_rollups: RollupsQuery,
  context_agent_ledger_org: LedgerQuery.extend({ nest_id: NEST_ID }),
  context_agent_rollups_org: RollupsQuery.extend({ nest_id: NEST_ID }),
} as const;
export type AgentMcpTool = keyof typeof AGENT_MCP_INPUTS;

/**
 * The MCP input schema for a zod object: its JSON Schema (input side, so
 * optional-with-default fields aren't required). Generated, never hand-written,
 * so it adds no inline literal to src/mcp/ (lint:mcp-schemas).
 */
export function mcpInputSchema(schema: z.ZodType): { type: "object"; properties: Record<string, unknown>; required: string[] } {
  const js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, any>;
  return {
    type: "object",
    properties: (js.properties ?? {}) as Record<string, unknown>,
    required: Array.isArray(js.required) ? js.required : [],
  };
}

// ─── Validation → 422 naming the field ─────────────────────────────────────

function fieldOf(issue: z.core.$ZodIssue, prefix: string): string {
  const path = [prefix, ...issue.path.map(String)].filter(Boolean).join(".");
  if (issue.code === "unrecognized_keys") {
    const keys = (issue as any).keys as string[];
    return keys.map((k) => (path ? `${path}.${k}` : k)).join(", ");
  }
  return path || "body";
}

/** Parse or throw a 422 `{code: "invalid_field", field, error}` naming the first bad field. */
export function parseOr422<S extends z.ZodType>(schema: S, value: unknown, prefix = ""): z.output<S> {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const field = fieldOf(issue, prefix);
  const message =
    issue.code === "unrecognized_keys" ? `${field}: unknown field` : `${field}: ${issue.message}`;
  throw new CodedError(422, message, "invalid_field", { field });
}

/** A typed step's detail, validated; untyped actions pass through unchanged. */
export function parseStepDetail(action: string, detail: unknown): unknown {
  if (!isTypedStepAction(action)) return detail;
  return parseOr422(TYPED_STEP_DETAIL[action], detail, "detail");
}

/** Validate an Idempotency-Key value (header or MCP argument). */
export function parseIdempotencyKey(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !IDEMPOTENCY_KEY_RE.test(v)) {
    throw new CodedError(422, "Idempotency-Key: must be 1-128 characters of A-Z a-z 0-9 . _ : -", "invalid_field", {
      field: "Idempotency-Key",
    });
  }
  return v;
}

// ─── Idempotency helpers ───────────────────────────────────────────────────

/** Verdict precedence: a run's ledger verdict is its strongest decision. */
export const VERDICT_RANK: Record<string, number> = { escalate: 4, propose: 3, act: 2, no_op: 1 };

/** A unique-index violation on either driver (the idempotency backstop). */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "23505";
}

export function idempotencyConflict(what: "run" | "step"): CodedError {
  return new CodedError(
    409,
    `Idempotency-Key was already used for a different ${what} request. Use a new key for a new ${what}.`,
    "idempotency_conflict",
  );
}
