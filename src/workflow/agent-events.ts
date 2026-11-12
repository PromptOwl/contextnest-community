/**
 * Agent event API (po-1186 CR1) — the write side an outside agent reports
 * through: register an agent, start a report-only run, append typed steps,
 * close the run. It extends the runs API rather than adding a route family
 * (api-contract §1), so these helpers sit beside run-service and are shared by
 * the REST routes (run-routes.ts, ledger-routes.ts) and the MCP tools
 * (mcp/agent-tools.ts, mcp/workflow-tools.ts).
 *
 * Permission-agnostic like run-service: callers resolve the nest, the tier,
 * licence and suspension first. What this module adds: idempotency (one run
 * per (nest, key), one step per (run, key), CAS-safe replays), per-credential
 * rate limits, and the "external writes need a nest-scoped key" rule.
 */
import { v4 as uuid } from "uuid";
import type { NestStorage } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { CodedError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { tryConsume, retryAfterSeconds, type RateLimitConfig } from "../shared/rate-limit.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { RUNNABLE_TYPES, closeRun, loadRun, replayableRun, type RunRequestShape, type StoredRun } from "./run-service.js";
import {
  AGENT_API_VERSION,
  parseOr422,
  AgentRunCloseBody,
  AgentRegisterBody,
  isUniqueViolation,
} from "./agent-event-schema.js";
import { createNode } from "../nodes/service.js";
import { listNestPeople } from "../nests/people-service.js";
import { z } from "zod";

// ─── Rate limits ───────────────────────────────────────────────────────────

export type AgentRateKind = "runs" | "events" | "reads" | "export";

function rateConfig(kind: AgentRateKind): RateLimitConfig {
  switch (kind) {
    case "runs":
      return { max: config.AGENT_RUNS_RATE_PER_MIN, windowMs: 60_000 };
    case "events":
      return { max: config.AGENT_EVENTS_RATE_PER_MIN, windowMs: 60_000 };
    case "reads":
      return { max: 120, windowMs: 60_000 };
    case "export":
      return { max: 6, windowMs: 3_600_000 };
  }
}

/**
 * Consume one request of `kind` for this credential (the API key when there
 * is one, else the user), or throw 429 `rate_limited` with Retry-After.
 * Export is per user, whatever key they use.
 */
export function consumeAgentRate(kind: AgentRateKind, who: { apiKeyId?: string | null; userId: string }): void {
  const cfg = rateConfig(kind);
  const principal = kind === "export" || !who.apiKeyId ? `user:${who.userId}` : `key:${who.apiKeyId}`;
  const key = `agent-api:${kind}:${principal}`;
  if (tryConsume(key, cfg)) return;
  const retry = retryAfterSeconds(key, cfg);
  throw new CodedError(
    429,
    `Too many requests: at most ${cfg.max} per ${cfg.windowMs / 1000} s for this credential. Retry in ${retry} s.`,
    "rate_limited",
    { limit: cfg.max, window_s: cfg.windowMs / 1000, retry_after_s: retry },
    { "Retry-After": String(retry) },
  );
}

// ─── External writes: nest-scoped keys only ────────────────────────────────

/**
 * An outside agent writes into ONE nest, with a key minted for that nest
 * (decision 2, 2026-11-09). A person in the app (session, no key) may still
 * act on an external run — cancel it, say — but an API key must be scoped to
 * this nest, and an OAuth grant (a person's delegated access, not an agent
 * credential) can't report as an external agent. Open mode has no keys.
 */
export async function assertExternalWriteCredential(cred: {
  nestId: string;
  apiKeyId: string | null;
  oauth?: boolean;
  /** MCP: the call came over a transport with no key at all (ticket/session). */
  requireKey?: boolean;
}): Promise<void> {
  if (config.AUTH_MODE === "open") return;
  if (cred.oauth) {
    throw new ForbiddenError(
      "External agent writes need a nest-scoped API key for this nest (POST /auth/keys with nest_id). An OAuth grant can't report as an agent.",
    );
  }
  if (!cred.apiKeyId) {
    if (cred.requireKey) {
      throw new ForbiddenError("External agent writes need a nest-scoped API key for this nest (POST /auth/keys with nest_id).");
    }
    return;
  }
  const key = (await getDb().get("SELECT nest_id FROM api_keys WHERE id = ?", [cred.apiKeyId])) as
    | { nest_id: string | null }
    | undefined;
  if (!key?.nest_id || key.nest_id !== cred.nestId) {
    throw new ForbiddenError(
      "External agent writes need a nest-scoped API key for this nest (POST /auth/keys with nest_id). This key is not scoped to the nest.",
    );
  }
}

// ─── Idempotent run start ──────────────────────────────────────────────────

/** `started_at` for a report: at most 24 h back, not in the future (±2 min skew). */
export function reportStartedAt(v: string | undefined, nowMs = Date.now()): string {
  if (!v) return new Date(nowMs).toISOString();
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t > nowMs + 120_000 || t < nowMs - 24 * 3600_000) {
    throw new CodedError(422, "started_at: must be within the last 24 hours and not in the future", "invalid_field", {
      field: "started_at",
    });
  }
  return new Date(t).toISOString();
}

/** Read an agent node and require it to be runnable (agent / skill). */
export async function assertRunnableAgent(storage: NestStorage, agentNode: string): Promise<{ title: string; type: string }> {
  let doc;
  try {
    doc = await storage.readDocument(agentNode);
  } catch {
    throw new NotFoundError(`Agent node not found: ${agentNode}. Register it first (POST /nests/:nestId/agents).`);
  }
  const type = (doc.frontmatter.type as string) || "document";
  if (!RUNNABLE_TYPES.includes(type)) {
    throw new ValidationError(`"${agentNode}" is type "${type}" — only agent/skill nodes are runnable`);
  }
  return { title: String(doc.frontmatter.title ?? agentNode), type };
}

/**
 * Start a report-only run (E2 with report_only): an outside agent records
 * that it ran. No bundle is built. Idempotent on (nest, key).
 */
export async function startReportRun(opts: {
  nestId: string;
  agentNode: string;
  storage: NestStorage;
  triggeredBy: string;
  inputs: unknown;
  startedAt?: string;
  externalRef?: string;
  idempotencyKey: string | null;
}): Promise<{ run_id: string; idempotent_replay?: true; api_version: string; parent_run_id: null; depth: 0 }> {
  const agentNode = assertSafeNodeId(opts.agentNode);
  const startedAt = reportStartedAt(opts.startedAt);
  const req: RunRequestShape = {
    agentNode,
    inputs: opts.inputs === undefined ? null : JSON.stringify(opts.inputs),
    externalRef: opts.externalRef ?? null,
    source: "external",
    parentRunId: null,
    startedAt: opts.startedAt ? startedAt : null,
  };
  const replay = (row: StoredRun) => ({
    run_id: row.id,
    idempotent_replay: true as const,
    api_version: AGENT_API_VERSION,
    parent_run_id: null,
    depth: 0 as const,
  });
  if (opts.idempotencyKey) {
    const prior = await replayableRun(opts.nestId, opts.idempotencyKey, req);
    if (prior) return replay(prior);
  }
  await assertRunnableAgent(opts.storage, agentNode);
  const db = getDb();
  const id = `run_${uuid()}`;
  try {
    await db.transaction(async (tx) => {
      // Report-only runs count against the same flood cap as runner roots:
      // an agent that never closes its runs can't pile up unbounded.
      const { n } = (await tx.get(
        `SELECT COUNT(*) AS n FROM runs WHERE nest_id = ? AND parent_run_id IS NULL AND status = 'running'`,
        [opts.nestId],
      )) as { n: number | string };
      if (Number(n) >= config.RUN_MAX_CONCURRENT_ROOTS) {
        throw new ConflictError(
          `too many concurrent runs: ${n} already running (cap ${config.RUN_MAX_CONCURRENT_ROOTS}). Close finished runs, or raise RUN_MAX_CONCURRENT_ROOTS.`,
        );
      }
      await tx.run(
        `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, inputs, started_at, parent_run_id, depth,
                           idempotency_key, source, external_ref)
         VALUES (?, ?, ?, ?, 'running', ?, ?, NULL, 0, ?, 'external', ?)`,
        [id, opts.nestId, agentNode, opts.triggeredBy, req.inputs, startedAt, opts.idempotencyKey, req.externalRef],
      );
    });
  } catch (err) {
    // Two concurrent starts with one key: the unique index lets one in; the
    // loser replays the winner (or 409s if its body differs).
    if (opts.idempotencyKey && isUniqueViolation(err)) {
      const prior = await replayableRun(opts.nestId, opts.idempotencyKey, req);
      if (prior) return replay(prior);
    }
    throw err;
  }
  return { run_id: id, api_version: AGENT_API_VERSION, parent_run_id: null, depth: 0 };
}

// ─── Idempotent close (E4) ─────────────────────────────────────────────────

/**
 * The trace a close stores: the caller's `trace` object with `usage`,
 * `est_cost_usd` and `summary` merged in under the keys metacognition runs
 * already use, so external runs roll up the same way. undefined = leave the
 * stored trace alone.
 */
export function closeTrace(body: z.output<typeof AgentRunCloseBody>): Record<string, unknown> | undefined {
  const t: Record<string, unknown> = { ...(body.trace ?? {}) };
  if (body.usage !== undefined) t.usage = body.usage;
  if (body.est_cost_usd !== undefined) t.est_cost_usd = body.est_cost_usd;
  if (body.summary !== undefined) t.summary = body.summary;
  return body.trace === undefined && body.usage === undefined && body.est_cost_usd === undefined && body.summary === undefined
    ? undefined
    : t;
}

/**
 * Close a run (CAS, terminal is final). A repeat of the close that won —
 * same status, same trace — is `idempotent_replay: true` instead of a 409.
 */
export async function closeRunIdempotent(
  runId: string,
  raw: unknown,
): Promise<{ status: string; idempotent_replay?: true; api_version: string }> {
  const body = parseOr422(AgentRunCloseBody, raw);
  const trace = closeTrace(body);
  try {
    const { status } = await closeRun(runId, { status: body.status, trace });
    return { status, api_version: AGENT_API_VERSION };
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
    const run = await loadRun(runId);
    if (run && run.status === body.status && (trace === undefined || run.trace === JSON.stringify(trace))) {
      return { status: run.status, idempotent_replay: true, api_version: AGENT_API_VERSION };
    }
    throw err;
  }
}

// ─── Register (E1) ─────────────────────────────────────────────────────────

/** The node id an agent registers under: given (under nodes/), or nodes/agents/<slug>. */
export function agentNodeId(nodeId: string | undefined, name: string): string {
  if (nodeId) {
    const id = nodeId.startsWith("nodes/") ? nodeId : `nodes/${nodeId}`;
    return assertSafeNodeId(id);
  }
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  if (!slug) throw new CodedError(422, "name: needs at least one letter or digit, or pass node_id", "invalid_field", { field: "name" });
  return `nodes/agents/${slug}`;
}

/**
 * Register an outside agent (E1): upsert an `agent` node with
 * `metadata.agent = {executes, runtime, owner}`. The node goes through normal
 * governance (stewardship applies). An existing agent node with that id is a
 * no-op `created: false`; any other node there is a 409. Owner/admin only —
 * the caller checks the credential's resolved permission, so a nest-scoped
 * key minted by an owner/admin can register (AC-CR-08); a key whose user has
 * only write or read access on the nest can't.
 */
export async function registerAgent(opts: {
  nestId: string;
  storage: NestStorage;
  callerEmail: string;
  raw: unknown;
}): Promise<{ node_id: string; created: boolean; api_version: string; status?: string }> {
  const body = parseOr422(AgentRegisterBody, opts.raw);
  const nodeId = agentNodeId(body.node_id, body.name);
  let existing;
  try {
    existing = await opts.storage.readDocument(nodeId);
  } catch {
    existing = null;
  }
  if (existing) {
    if ((existing.frontmatter.type as string) !== "agent") {
      throw new ConflictError(`"${nodeId}" exists and is not an agent node — pick another node_id.`);
    }
    return { node_id: nodeId, created: false, api_version: AGENT_API_VERSION };
  }
  const owner = (body.owner ?? opts.callerEmail).toLowerCase();
  if (body.owner) {
    const people = await listNestPeople(opts.nestId);
    if (!people.some((p) => p.email.toLowerCase() === owner)) {
      throw new CodedError(422, "owner: must be a person on this nest", "invalid_field", { field: "owner" });
    }
  }
  const { node } = await createNode(
    opts.nestId,
    {
      id: nodeId,
      title: body.name,
      content: `# ${body.name}\n\n${body.description ?? "An agent that reports its runs to this nest."}\n`,
      type: "agent",
      agent: { executes: body.executes ?? "external", runtime: body.runtime ?? null, owner },
    },
    opts.callerEmail,
  );
  return { node_id: node.id, created: true, api_version: AGENT_API_VERSION, status: (node as { status?: string }).status };
}
