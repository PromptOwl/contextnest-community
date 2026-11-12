/**
 * The decision ledger (po-1186 CR1): one row per agent decision — every time
 * an agent looked at something and concluded, including "do nothing" — with
 * the chain from the run to the saved version.
 *
 * A read model, never a log of its own (the pattern of scoped-activity-service
 * and agent-activity-service): it unions what is already recorded.
 *   1. Listener windows: `surface_windows` (judged) ⟕ proposals ⟕ items ⟕
 *      commits, with the listener's run through `surface_windows.run_id`.
 *   2. Every other run (metacognition, runner, external): `runs` ⟕ the
 *      decision verdict denormalised on the run ⟕ `review_requests.run_id`.
 * Listener runs are reached through their window, never listed twice.
 *
 * One predicate builder (`ledgerWhere`) serves the page, the totals, the
 * export and the rollups (rollup-service), and one tally (`tally`) counts
 * both, so a bucket's counts equal the ledger totals for the same range and
 * filters by construction (AC-CR-10).
 *
 * Redaction, identical on every surface that calls in (REST, MCP, export):
 *   - N1 (src/surfaces/n1.ts): a personal nest's rows lose title, source,
 *     summary, evidence, reviewer and the saved node id for anyone but its
 *     owner — a server admin included — and say `redacted: "n1"`. Counts stay.
 *   - Read tier: run inputs/trace, step detail, decision summary and evidence
 *     are null below write (the run-routes posture).
 * No field carries message text: windows store none, and an agent's decision
 * holds its own one-line summary and references only.
 */
import { getDb } from "../db/client.js";
import { safeJson } from "../shared/json.js";
import { config } from "../config.js";
import { isServerAdminUserId, resolveNestPermission, permissionLevel } from "../shared/access.js";
import { PRIVATE_CONVERSATION, PRIVATE_TITLE, n1Redacts, personalOwners } from "../surfaces/n1.js";
import { outcomeOf } from "../metacognition/stats.js";
import { AGENT_API_VERSION } from "../workflow/agent-event-schema.js";
import { CodedError, NotFoundError } from "../shared/errors.js";

// ─── Scope ─────────────────────────────────────────────────────────────────

/** Who is reading, over which nests, at which tier per nest. */
export interface LedgerScope {
  viewerUserId: string;
  nestIds: string[];
  /** Nests where the viewer may see write-tier detail. */
  detailNests: Set<string>;
}

/** A single nest the viewer already passed the read gate on. */
export function nestScope(nestId: string, viewerUserId: string, canSeeDetail: boolean): LedgerScope {
  return { viewerUserId, nestIds: [nestId], detailNests: canSeeDetail ? new Set([nestId]) : new Set() };
}

/**
 * The org-wide scope (decision 3, 2026-11-09): a server admin sees every
 * nest; anyone else the nests they own or administer. A nest-scoped key stays
 * inside its nest. Service identities see nothing org-wide.
 */
export async function orgScope(
  viewerUserId: string,
  opts: { keyNestScope?: string | null; readOnlyKey?: boolean; onlyNest?: string } = {},
): Promise<LedgerScope> {
  const db = getDb();
  const service = (await db.get("SELECT is_service FROM users WHERE id = ?", [viewerUserId])) as
    | { is_service: number | null }
    | undefined;
  let ids: string[];
  if (config.AUTH_MODE === "open" || (!service?.is_service && (await isServerAdminUserId(viewerUserId)))) {
    ids = ((await db.all("SELECT id FROM nests", [])) as Array<{ id: string }>).map((r) => r.id);
  } else if (service?.is_service) {
    ids = [];
  } else {
    const candidates = (await db.all(
      `SELECT id FROM nests WHERE user_id = ?
       UNION SELECT nest_id AS id FROM nest_collaborators WHERE user_id = ? AND permission = 'admin'`,
      [viewerUserId, viewerUserId],
    )) as Array<{ id: string }>;
    ids = [];
    for (const c of candidates) {
      if (permissionLevel(await resolveNestPermission(c.id, viewerUserId)) >= permissionLevel("admin")) ids.push(c.id);
    }
  }
  if (opts.keyNestScope) ids = ids.filter((id) => id === opts.keyNestScope);
  if (opts.onlyNest) ids = ids.filter((id) => id === opts.onlyNest);
  return { viewerUserId, nestIds: ids, detailNests: opts.readOnlyKey ? new Set() : new Set(ids) };
}

// ─── Filters ───────────────────────────────────────────────────────────────

export interface LedgerFilters {
  from?: string;
  to?: string;
  agent?: string;
  verdict?: string;
  state?: string;
  source?: string;
  binding?: string;
  q?: string;
}

const DAY_MS = 86_400_000;

/** The range the filters mean: default the last 7 days, at most 366. */
export function ledgerRange(f: LedgerFilters, nowMs = Date.now()): { from: string; to: string } {
  const to = f.to ? new Date(f.to).toISOString() : new Date(nowMs).toISOString();
  const from = f.from ? new Date(f.from).toISOString() : new Date(Date.parse(to) - 7 * DAY_MS).toISOString();
  if (Date.parse(from) > Date.parse(to)) {
    throw new CodedError(422, "from: must be before to", "invalid_field", { field: "from" });
  }
  if (Date.parse(to) - Date.parse(from) > 366 * DAY_MS) {
    throw new CodedError(422, "from: the range can be at most 366 days", "invalid_field", { field: "from" });
  }
  return { from, to };
}

// ─── The union ─────────────────────────────────────────────────────────────

const ITEM_COUNTS = `
  SELECT p.window_id AS wid, MIN(i.title) AS title, MIN(p.id) AS proposal_id, COUNT(*) AS n_prop,
         SUM(CASE WHEN i.state = 'approved' THEN 1 ELSE 0 END) AS n_app,
         SUM(CASE WHEN i.state = 'approved' AND i.edited = 1 THEN 1 ELSE 0 END) AS n_edit,
         SUM(CASE WHEN i.state = 'rejected' THEN 1 ELSE 0 END) AS n_rej,
         SUM(CASE WHEN i.state = 'expired' THEN 1 ELSE 0 END) AS n_exp,
         SUM(CASE WHEN i.state IN ('pending', 'creating') THEN 1 ELSE 0 END) AS n_pend,
         SUM(CASE WHEN i.state = 'withdrawn' THEN 1 ELSE 0 END) AS n_wd
    FROM surface_proposal_items i JOIN surface_proposals p ON p.id = i.proposal_id
   WHERE i.state <> 'dropped'
   GROUP BY p.window_id`;

const REVIEW_COUNTS = `
  SELECT run_id AS rid, MIN(node_id) AS title, MIN(id) AS proposal_id, COUNT(*) AS n_prop,
         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS n_app,
         SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS n_rej,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS n_pend,
         SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS n_wd
    FROM review_requests WHERE run_id IS NOT NULL
   GROUP BY run_id`;

/**
 * Every ledger row, both families, one column shape. The page and the trace
 * need the run's trace (its outcome); the totals and rollups never read it,
 * so their variant leaves the column out.
 */
const ledgerUnion = (withTrace: boolean) => `(
  SELECT 'win_' || w.id AS entry_id,
         w.judged_at AS at,
         w.nest_id AS nest_id,
         COALESCE(lr.agent_node, b.listener_agent_node_id) AS agent_node,
         'surfaces' AS source,
         -- Window verdicts: proposed / forced → propose; filtered (every item
         -- blocked) → no_op with its reason; every failure (error,
         -- error_schema, budget_exhausted, no_target_folder) → error.
         CASE WHEN w.verdict IN ('proposed', 'forced') THEN 'propose'
              WHEN w.verdict = 'filtered' THEN 'no_op'
              WHEN w.verdict IN ('error', 'error_schema', 'budget_exhausted', 'no_target_folder') THEN 'error'
              ELSE w.verdict END AS verdict,
         w.reason_code AS reason_code,
         w.run_id AS run_id,
         lr.status AS run_status,${withTrace ? "\n         lr.trace AS run_trace," : ""}
         COALESCE(w.cost_micros, 0) AS cost_micros,
         0 AS tokens,
         w.binding_id AS binding_id,
         w.id AS window_id,
         w.kinds AS kinds,
         w.message_count AS message_count,
         CAST(NULL AS TEXT) AS external_ref,
         ic.title AS title,
         ic.proposal_id AS proposal_id,
         COALESCE(ic.n_prop, 0) AS n_prop,
         COALESCE(ic.n_app, 0) AS n_app,
         COALESCE(ic.n_edit, 0) AS n_edit,
         COALESCE(ic.n_rej, 0) AS n_rej,
         COALESCE(ic.n_exp, 0) AS n_exp,
         COALESCE(ic.n_pend, 0) AS n_pend,
         COALESCE(ic.n_wd, 0) AS n_wd
    FROM surface_windows w
    LEFT JOIN surface_bindings b ON b.id = w.binding_id
    LEFT JOIN runs lr ON lr.id = w.run_id
    LEFT JOIN (${ITEM_COUNTS}) ic ON ic.wid = w.id
   WHERE w.status = 'judged' AND w.judged_at IS NOT NULL
  UNION ALL
  SELECT r.id AS entry_id,
         r.started_at AS at,
         r.nest_id AS nest_id,
         r.agent_node AS agent_node,
         CASE WHEN r.source = 'server:metacognition' OR r.claimed_by = 'server:metacognition' THEN 'metacognition'
              WHEN r.source = 'external' THEN 'external'
              ELSE 'runner' END AS source,
         CASE WHEN r.status = 'failed' THEN 'error'
              WHEN r.verdict IS NOT NULL THEN r.verdict
              WHEN rc.n_prop > 0 THEN 'propose'
              ELSE NULL END AS verdict,
         r.reason_code AS reason_code,
         r.id AS run_id,
         r.status AS run_status,${withTrace ? "\n         r.trace AS run_trace," : ""}
         -- Denormalised onto the run at close (run-totals.ts).
         COALESCE(r.est_cost_micros, 0) AS cost_micros,
         COALESCE(r.tokens, 0) AS tokens,
         CAST(NULL AS TEXT) AS binding_id,
         CAST(NULL AS TEXT) AS window_id,
         CAST(NULL AS TEXT) AS kinds,
         CAST(NULL AS INTEGER) AS message_count,
         r.external_ref AS external_ref,
         rc.title AS title,
         rc.proposal_id AS proposal_id,
         COALESCE(rc.n_prop, 0) AS n_prop,
         COALESCE(rc.n_app, 0) AS n_app,
         0 AS n_edit,
         COALESCE(rc.n_rej, 0) AS n_rej,
         0 AS n_exp,
         COALESCE(rc.n_pend, 0) AS n_pend,
         COALESCE(rc.n_wd, 0) AS n_wd
    FROM runs r
    LEFT JOIN (${REVIEW_COUNTS}) rc ON rc.rid = r.id
   WHERE r.source <> 'server:surfaces' AND r.triggered_by <> 'surfaces:window'
) l`;
const LEDGER_UNION = ledgerUnion(true);
const LEDGER_UNION_AGG = ledgerUnion(false);

const STATE_COLUMN: Record<string, string> = {
  pending: "n_pend",
  approved: "n_app",
  edited: "n_edit",
  rejected: "n_rej",
  expired: "n_exp",
  withdrawn: "n_wd",
};

/**
 * THE predicate builder: the page, the totals, the export and the rollups all
 * filter through this, so they can't disagree. `redactedNests` are the N1
 * nests this viewer can't search by title.
 */
export function ledgerWhere(
  scope: LedgerScope,
  f: LedgerFilters,
  range: { from: string; to: string },
  redactedNests: Set<string>,
): { sql: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (!scope.nestIds.length) where.push("1 = 0");
  else {
    where.push(`l.nest_id IN (${scope.nestIds.map(() => "?").join(",")})`);
    args.push(...scope.nestIds);
  }
  where.push("l.at >= ?", "l.at < ?");
  args.push(range.from, range.to);
  if (f.agent) (where.push("l.agent_node = ?"), args.push(f.agent));
  if (f.verdict) (where.push("l.verdict = ?"), args.push(f.verdict));
  if (f.source) (where.push("l.source = ?"), args.push(f.source));
  if (f.binding) (where.push("l.binding_id = ?"), args.push(f.binding));
  if (f.state && STATE_COLUMN[f.state]) where.push(`l.${STATE_COLUMN[f.state]} > 0`);
  if (f.q) {
    where.push("LOWER(COALESCE(l.title, '')) LIKE ? ESCAPE '\\'");
    args.push(`%${f.q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    if (redactedNests.size) {
      where.push(`l.nest_id NOT IN (${[...redactedNests].map(() => "?").join(",")})`);
      args.push(...redactedNests);
    }
  }
  return { sql: `WHERE ${where.join(" AND ")}`, args };
}

// ─── Tally (shared with the rollups) ───────────────────────────────────────

/**
 * One aggregate group: the tally of every ledger row with this UTC day, nest,
 * agent, binding, source and reason code. Totals and rollups sum these; SQL does the
 * per-row work (`TALLY_SQL`).
 */
export interface AggRow {
  day: string;
  /** The latest row in the group. */
  last_at: string;
  nest_id: string;
  agent_node: string | null;
  binding_id: string | null;
  source: string;
  /** The verdict's reason code (rollups by=reason). */
  reason_code: string | null;
  entries: number | string;
  failed: number | string | null;
  no_op: number | string | null;
  propose: number | string | null;
  act: number | string | null;
  escalate: number | string | null;
  error: number | string | null;
  none: number | string | null;
  proposals: number | string | null;
  approved: number | string | null;
  edited: number | string | null;
  rejected: number | string | null;
  expired: number | string | null;
  pending: number | string | null;
  withdrawn: number | string | null;
  cost_micros: number | string | null;
  tokens: number | string | null;
}

export interface Tally {
  entries: number;
  runs: number;
  failed: number;
  no_op: number;
  propose: number;
  act: number;
  escalate: number;
  error: number;
  none: number;
  proposals: number;
  approved: number;
  edited: number;
  rejected: number;
  expired: number;
  pending: number;
  withdrawn: number;
  cost_usd: number;
  tokens: number;
}

export const emptyTally = (): Tally & { cost_micros: number } => ({
  entries: 0,
  runs: 0,
  failed: 0,
  no_op: 0,
  propose: 0,
  act: 0,
  escalate: 0,
  error: 0,
  none: 0,
  proposals: 0,
  approved: 0,
  edited: 0,
  rejected: 0,
  expired: 0,
  pending: 0,
  withdrawn: 0,
  cost_usd: 0,
  tokens: 0,
  cost_micros: 0,
});

const VERDICTS = ["no_op", "propose", "act", "escalate", "error"] as const;

/**
 * THE tally, in SQL: one row's contribution, summed. Every row is one entry
 * and one run; a failed run or an error verdict is a failure; a verdict
 * outside the five (or none) counts as `none`.
 */
const TALLY_SQL = `COUNT(*) AS entries,
       SUM(CASE WHEN l.run_status = 'failed' OR l.verdict = 'error' THEN 1 ELSE 0 END) AS failed,
       ${VERDICTS.map((v) => `SUM(CASE WHEN l.verdict = '${v}' THEN 1 ELSE 0 END) AS ${v}`).join(",\n       ")},
       SUM(CASE WHEN l.verdict IN (${VERDICTS.map((v) => `'${v}'`).join(", ")}) THEN 0 ELSE 1 END) AS none,
       SUM(l.n_prop) AS proposals, SUM(l.n_app) AS approved, SUM(l.n_edit) AS edited, SUM(l.n_rej) AS rejected,
       SUM(l.n_exp) AS expired, SUM(l.n_pend) AS pending, SUM(l.n_wd) AS withdrawn,
       SUM(l.cost_micros) AS cost_micros, SUM(l.tokens) AS tokens`;

const num = (v: unknown) => Number(v) || 0;

/** Add one aggregate group into a tally (mutates). */
export function addToTally(t: Tally & { cost_micros: number }, r: Omit<AggRow, "day" | "last_at" | "nest_id" | "agent_node" | "binding_id" | "source" | "reason_code">): void {
  t.entries += num(r.entries);
  t.runs += num(r.entries);
  t.failed += num(r.failed);
  for (const v of VERDICTS) t[v] += num(r[v]);
  t.none += num(r.none);
  t.proposals += num(r.proposals);
  t.approved += num(r.approved);
  t.edited += num(r.edited);
  t.rejected += num(r.rejected);
  t.expired += num(r.expired);
  t.pending += num(r.pending);
  t.withdrawn += num(r.withdrawn);
  t.cost_micros += num(r.cost_micros);
  t.tokens += num(r.tokens);
}

export function finishTally(t: Tally & { cost_micros: number }): Tally {
  const { cost_micros, ...rest } = t;
  return { ...rest, cost_usd: cost_micros / 1_000_000 };
}

/**
 * The rows matching the filters, aggregated in SQL by UTC day × nest × agent
 * × binding × source × reason code (totals + rollups). Bounded by days × groups, never by
 * the number of rows, and never reads a run's trace.
 */
export async function aggregateRows(scope: LedgerScope, f: LedgerFilters): Promise<{ rows: AggRow[]; range: { from: string; to: string } }> {
  const range = ledgerRange(f);
  const owners = await personalOwners(scope.nestIds);
  const redacted = new Set(scope.nestIds.filter((id) => n1Redacts(owners, id, scope.viewerUserId)));
  const { sql, args } = ledgerWhere(scope, f, range, redacted);
  const rows = (await getDb().all(
    `SELECT substr(l.at, 1, 10) AS day, MAX(l.at) AS last_at, l.nest_id, l.agent_node, l.binding_id, l.source, l.reason_code,
            ${TALLY_SQL}
       FROM ${LEDGER_UNION_AGG} ${sql}
      GROUP BY substr(l.at, 1, 10), l.nest_id, l.agent_node, l.binding_id, l.source, l.reason_code`,
    args as any,
  )) as AggRow[];
  return { rows, range };
}

/** The whole range's tally, one SQL aggregate. */
async function totalsFor(sql: string, args: unknown[]): Promise<Tally> {
  const row = (await getDb().get(`SELECT ${TALLY_SQL} FROM ${LEDGER_UNION_AGG} ${sql}`, args as any)) as AggRow | undefined;
  const t = emptyTally();
  if (row) addToTally(t, row);
  return finishTally(t);
}

// ─── Page ──────────────────────────────────────────────────────────────────

interface LedgerRow {
  entry_id: string;
  at: string;
  nest_id: string;
  agent_node: string | null;
  binding_id: string | null;
  source: string;
  verdict: string | null;
  reason_code: string | null;
  run_id: string | null;
  run_status: string | null;
  run_trace: string | null;
  cost_micros: number | string | null;
  window_id: string | null;
  kinds: string | null;
  message_count: number | string | null;
  external_ref: string | null;
  title: string | null;
  proposal_id: string | null;
  n_prop: number | string;
  n_app: number | string;
  n_edit: number | string;
  n_rej: number | string;
  n_exp: number | string;
  n_pend: number | string;
  n_wd: number | string;
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id])).toString("base64url");
}

function decodeCursor(c: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string") return [v[0], v[1]];
  } catch {
    /* fall through */
  }
  throw new CodedError(422, "cursor: not a cursor this API returned", "invalid_field", { field: "cursor" });
}

const CHUNK = 500;

/** `SELECT … WHERE <col> IN (…)`, chunked so a long list stays under the bind limits. */
async function allIn<T>(sql: (ph: string) => string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    out.push(...((await getDb().all(sql(chunk.map(() => "?").join(",")), chunk as any)) as T[]));
  }
  return out;
}

const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))];

type BindingLabel = { conversation_name: string | null; conversation_id: string; surface: string | null; team: string | null };

/** Labels for nests, agents and bindings: one query each per page, never one per row. */
async function labelsFor(rows: Array<{ nest_id: string; agent_node: string | null; binding_id?: string | null }>) {
  const nestIds = uniq(rows.map((r) => r.nest_id));
  const nests = new Map<string, string>();
  for (const n of await allIn<{ id: string; name: string }>((ph) => `SELECT id, name FROM nests WHERE id IN (${ph})`, nestIds)) nests.set(n.id, n.name);
  const agents = new Map<string, string>();
  const nodeIds = uniq(rows.map((r) => r.agent_node));
  if (nodeIds.length) {
    // node_ids across the page's nests, then keep the (nest, node) pairs asked for.
    const wanted = new Set(rows.filter((r) => r.agent_node).map((r) => `${r.nest_id}\u0000${r.agent_node}`));
    for (let i = 0; i < nodeIds.length; i += CHUNK) {
      const chunk = nodeIds.slice(i, i + CHUNK);
      const found = (await getDb().all(
        `SELECT nest_id, node_id, title FROM node_index WHERE nest_id IN (${nestIds.map(() => "?").join(",")}) AND node_id IN (${chunk.map(() => "?").join(",")})`,
        [...nestIds, ...chunk] as any,
      )) as Array<{ nest_id: string; node_id: string; title: string | null }>;
      for (const a of found) {
        const k = `${a.nest_id}\u0000${a.node_id}`;
        if (wanted.has(k) && a.title) agents.set(k, a.title);
      }
    }
  }
  const bindings = new Map<string, BindingLabel>();
  for (const b of await allIn<BindingLabel & { id: string }>(
    (ph) => `SELECT b.id, b.conversation_name, b.conversation_id, i.surface, COALESCE(i.team_id, i.tenant_key) AS team
               FROM surface_bindings b LEFT JOIN surface_installs i ON i.id = b.install_id WHERE b.id IN (${ph})`,
    uniq(rows.map((r) => r.binding_id)),
  ))
    bindings.set(b.id, b);
  return {
    nest: (id: string) => nests.get(id) ?? id,
    agent: (nestId: string, nodeId: string | null) =>
      nodeId ? agents.get(`${nestId}\u0000${nodeId}`) || nodeId.split("/").pop() || nodeId : null,
    binding: (id: string | null) => (id ? bindings.get(id) ?? null : null),
  };
}

/** Slack (or other) conversation link derived at read time; never stored. */
function sourceOf(b: { conversation_name: string | null; conversation_id: string; surface: string | null; team: string | null } | null) {
  if (!b) return null;
  const surface = b.surface ?? "slack";
  const url =
    surface === "slack" && b.team && /^[A-Z0-9]+$/.test(b.team) && /^[A-Z0-9]+$/.test(b.conversation_id)
      ? `https://app.slack.com/client/${b.team}/${b.conversation_id}`
      : null;
  return { kind: surface, label: b.conversation_name ? `#${b.conversation_name}` : b.conversation_id, url };
}

/**
 * Everything a page of rows links to — the last decision of each run, the
 * first reviewer decision and latest commit of each window, the review of
 * each run, and the reviewers' emails — in a handful of queries per page.
 */
async function hydrate(rows: LedgerRow[]) {
  const windowIds = uniq(rows.filter((r) => r.source === "surfaces").map((r) => r.window_id));
  const runIds = uniq(rows.filter((r) => r.source !== "surfaces").map((r) => r.run_id));

  // The last decision step of a run (the one the agent concluded with).
  const decisions = new Map<string, { seq: number; detail: Record<string, any> | null }>();
  for (const d of await allIn<{ run_id: string; seq: number | string; detail: string | null }>(
    (ph) => `SELECT run_id, seq, detail FROM run_steps WHERE action = 'decision' AND run_id IN (${ph})`,
    runIds,
  )) {
    const seq = Number(d.seq);
    const prev = decisions.get(d.run_id);
    if (!prev || seq > prev.seq) decisions.set(d.run_id, { seq, detail: (safeJson(d.detail) as Record<string, any> | null) ?? null });
  }

  // A window's first decided item, by decided_at.
  const decided = new Map<string, { decided_by_user_id: string | null; decided_at: string; reason: string | null }>();
  for (const d of await allIn<{ window_id: string; decided_by_user_id: string | null; decided_at: string; reason: string | null }>(
    (ph) => `SELECT p.window_id, i.decided_by_user_id, i.decided_at, i.reason
               FROM surface_proposal_items i JOIN surface_proposals p ON p.id = i.proposal_id
              WHERE p.window_id IN (${ph}) AND i.decided_at IS NOT NULL`,
    windowIds,
  )) {
    const prev = decided.get(d.window_id);
    if (!prev || d.decided_at < prev.decided_at) decided.set(d.window_id, d);
  }

  // A window's latest commit.
  const commits = new Map<string, { node_id: string; version: number | null; created_at: string }>();
  for (const c of await allIn<{ window_id: string; node_id: string; version: number | null; created_at: string }>(
    (ph) => `SELECT window_id, node_id, version, created_at FROM surface_commits WHERE window_id IN (${ph})`,
    windowIds,
  )) {
    const prev = commits.get(c.window_id);
    if (!prev || c.created_at > prev.created_at) commits.set(c.window_id, c);
  }

  // A run's review: the latest resolved one, else an open one.
  type Rr = { run_id: string; resolved_by: string | null; resolved_at: string | null; resolution_note: string | null; status: string; node_id: string; version: number };
  const reviews = new Map<string, Rr>();
  for (const rr of await allIn<Rr>(
    (ph) => `SELECT run_id, resolved_by, resolved_at, resolution_note, status, node_id, version FROM review_requests WHERE run_id IN (${ph})`,
    runIds,
  )) {
    const prev = reviews.get(rr.run_id);
    const better = !prev || (prev.resolved_at === null ? rr.resolved_at !== null : rr.resolved_at !== null && rr.resolved_at > prev.resolved_at);
    if (better) reviews.set(rr.run_id, rr);
  }

  const emails = new Map<string, string>();
  for (const u of await allIn<{ id: string; email: string }>(
    (ph) => `SELECT id, email FROM users WHERE id IN (${ph})`,
    uniq([...decided.values()].map((d) => d.decided_by_user_id)),
  ))
    emails.set(u.id, u.email);

  return {
    decision: (runId: string) => decisions.get(runId)?.detail ?? null,
    decided: (windowId: string) => decided.get(windowId) ?? null,
    commit: (windowId: string) => commits.get(windowId) ?? null,
    review: (runId: string) => reviews.get(runId) ?? null,
    email: (userId: string | null) => (userId ? emails.get(userId) ?? null : null),
  };
}

function proposalState(r: { n_prop: unknown; n_app: unknown; n_edit: unknown; n_rej: unknown; n_exp: unknown; n_pend: unknown; n_wd: unknown }): string | null {
  if (!Number(r.n_prop)) return null;
  if (Number(r.n_pend)) return "pending";
  if (Number(r.n_edit)) return "edited";
  if (Number(r.n_app)) return "approved";
  if (Number(r.n_rej)) return "rejected";
  if (Number(r.n_exp)) return "expired";
  if (Number(r.n_wd)) return "withdrawn";
  return "pending";
}

/** One ledger row, serialised and redacted for this viewer. */
function serialise(
  r: LedgerRow,
  labels: Awaited<ReturnType<typeof labelsFor>>,
  links: Awaited<ReturnType<typeof hydrate>>,
  opts: { detail: boolean; n1: boolean },
): Record<string, unknown> {
  const isWindow = r.source === "surfaces";
  const trace = safeJson(r.run_trace) as Record<string, unknown> | null;
  const costMicros = Number(r.cost_micros) || 0;
  const entry: Record<string, any> = {
    entry_id: r.entry_id,
    at: r.at,
    nest: { id: r.nest_id, label: opts.n1 ? PRIVATE_TITLE : labels.nest(r.nest_id) },
    agent: { node_id: r.agent_node, name: labels.agent(r.nest_id, r.agent_node), source: r.source },
    run: r.run_id
      ? {
          id: r.run_id,
          outcome: r.run_status ? outcomeOf(r.run_status, trace as any) : null,
          cost_usd: costMicros / 1_000_000,
          external_ref: r.external_ref,
        }
      : null,
    verdict: {
      code: r.verdict,
      reason_code: r.reason_code,
      kinds: isWindow ? (safeJson(r.kinds) as string[] | null) ?? [] : null,
      message_count: r.message_count == null ? null : Number(r.message_count),
    },
    decision: null,
    proposal: null,
    review: null,
    commit: null,
    source: null,
    redacted: opts.n1 ? "n1" : null,
  };
  if (!isWindow && r.run_id) {
    const d = links.decision(r.run_id);
    if (d) {
      entry.decision = {
        verdict: d.verdict ?? null,
        reason_code: d.reason_code ?? null,
        confidence: typeof d.confidence === "number" ? d.confidence : null,
        summary: opts.detail ? d.summary ?? null : null,
        evidence: opts.detail ? d.evidence ?? [] : null,
      };
    }
  }
  const counts = {
    proposals: Number(r.n_prop),
    approved: Number(r.n_app),
    edited: Number(r.n_edit),
    rejected: Number(r.n_rej),
    expired: Number(r.n_exp),
    pending: Number(r.n_pend),
    withdrawn: Number(r.n_wd),
  };
  if (counts.proposals) {
    entry.proposal = {
      id: r.proposal_id,
      title: r.title,
      state: proposalState(r),
      edited: counts.edited > 0,
      counts,
    };
  }
  if (isWindow && r.window_id) {
    const decided = links.decided(r.window_id);
    if (decided) entry.review = { by: links.email(decided.decided_by_user_id), reason: decided.reason ?? null, at: decided.decided_at };
    const commit = links.commit(r.window_id);
    if (commit) entry.commit = { node_id: commit.node_id, version: commit.version == null ? null : Number(commit.version) };
    entry.source = sourceOf(labels.binding(r.binding_id));
  } else if (r.run_id) {
    const rr = links.review(r.run_id);
    if (rr?.resolved_at) entry.review = { by: rr.resolved_by, reason: rr.resolution_note ?? null, at: rr.resolved_at };
    if (rr?.status === "approved") entry.commit = { node_id: rr.node_id, version: Number(rr.version) };
    entry.source = r.source === "external" ? { kind: "agent", label: r.external_ref, url: null } : { kind: r.source, label: null, url: null };
  }
  if (opts.n1) redactN1(entry);
  return entry;
}

/** N1: drop what identifies the conversation or the people; keep counts. */
function redactN1(entry: Record<string, any>): void {
  delete entry.source;
  if (entry.proposal) delete entry.proposal.title;
  if (entry.decision) {
    delete entry.decision.summary;
    delete entry.decision.evidence;
  }
  if (entry.review) {
    delete entry.review.by;
    delete entry.review.reason;
  }
  if (entry.commit) delete entry.commit.node_id;
  if (entry.run) delete entry.run.external_ref;
}

export interface LedgerPage {
  api_version: string;
  range: { from: string; to: string };
  entries: Array<Record<string, unknown>>;
  next_cursor: string | null;
  totals: Tally;
}

/** One page of the ledger plus the totals for the whole filtered range. */
export async function listLedger(
  scope: LedgerScope,
  f: LedgerFilters & { cursor?: string; limit?: number },
  opts: { totals?: boolean } = {},
): Promise<LedgerPage> {
  const range = ledgerRange(f);
  const owners = await personalOwners(scope.nestIds);
  const redacted = new Set(scope.nestIds.filter((id) => n1Redacts(owners, id, scope.viewerUserId)));
  const { sql, args } = ledgerWhere(scope, f, range, redacted);
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? 50), 1), 200);
  let keyset = "";
  const kargs: unknown[] = [];
  if (f.cursor) {
    const [at, id] = decodeCursor(f.cursor);
    keyset = " AND (l.at < ? OR (l.at = ? AND l.entry_id < ?))";
    kargs.push(at, at, id);
  }
  const rows = (await getDb().all(
    `SELECT l.* FROM ${LEDGER_UNION} ${sql}${keyset} ORDER BY l.at DESC, l.entry_id DESC LIMIT ?`,
    [...args, ...kargs, limit + 1] as any,
  )) as LedgerRow[];
  const page = rows.slice(0, limit);
  const labels = await labelsFor(page);
  const links = await hydrate(page);
  const entries = page.map((r) => serialise(r, labels, links, { detail: scope.detailNests.has(r.nest_id), n1: redacted.has(r.nest_id) }));
  const totals = opts.totals !== false ? await totalsFor(sql, args) : finishTally(emptyTally());
  const last = page[page.length - 1];
  return {
    api_version: AGENT_API_VERSION,
    range,
    entries,
    next_cursor: rows.length > limit && last ? encodeCursor(last.at, last.entry_id) : null,
    totals,
  };
}

async function emailOf(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const row = (await getDb().get("SELECT email FROM users WHERE id = ?", [userId])) as { email: string } | undefined;
  return row?.email ?? null;
}

// ─── Trace ─────────────────────────────────────────────────────────────────

/** Which nest an entry id belongs to (null when there is no such entry). */
export async function ledgerEntryNest(entryId: string): Promise<string | null> {
  const db = getDb();
  if (entryId.startsWith("win_")) {
    const w = (await db.get("SELECT nest_id FROM surface_windows WHERE id = ? AND status = 'judged'", [entryId.slice(4)])) as
      | { nest_id: string }
      | undefined;
    return w?.nest_id ?? null;
  }
  if (entryId.startsWith("run_")) {
    const r = (await db.get(
      "SELECT nest_id FROM runs WHERE id = ? AND source <> 'server:surfaces' AND triggered_by <> 'surfaces:window'",
      [entryId],
    )) as { nest_id: string } | undefined;
    return r?.nest_id ?? null;
  }
  return null;
}

/**
 * One entry with its whole chain — run → verdict → proposal → review →
 * saved version → source — the run's steps, and `gaps`: the hops this entry
 * should have and doesn't. Empty for any committed node (AC-CR-05).
 */
export async function ledgerTrace(scope: LedgerScope, entryId: string): Promise<Record<string, unknown>> {
  const db = getDb();
  const nestId = await ledgerEntryNest(entryId);
  if (!nestId || !scope.nestIds.includes(nestId)) throw new NotFoundError("Ledger entry not found");
  const owners = await personalOwners([nestId]);
  const n1 = n1Redacts(owners, nestId, scope.viewerUserId);
  const detail = scope.detailNests.has(nestId) && !n1;
  const row = (await db.get(`SELECT l.* FROM ${LEDGER_UNION} WHERE l.entry_id = ? AND l.nest_id = ?`, [entryId, nestId])) as
    | LedgerRow
    | undefined;
  if (!row) throw new NotFoundError("Ledger entry not found");
  const labels = await labelsFor([row]);
  const entry = serialise(row, labels, await hydrate([row]), { detail, n1 });

  const chain: Record<string, any> = { run: null, verdict: null, proposal: null, review: null, version: null, source: null };
  const expected = new Set<string>(["verdict"]);
  if (row.run_id) {
    const run = (await db.get("SELECT * FROM runs WHERE id = ?", [row.run_id])) as Record<string, any> | undefined;
    if (run) {
      chain.run = {
        id: run.id,
        agent_node: run.agent_node,
        status: run.status,
        outcome: outcomeOf(run.status, safeJson(run.trace) as any),
        triggered_by: n1 ? undefined : run.triggered_by,
        started_at: run.started_at,
        finished_at: run.finished_at,
        cost_usd: (entry.run as any)?.cost_usd ?? 0,
        external_ref: n1 ? undefined : run.external_ref ?? null,
        inputs: detail ? safeJson(run.inputs) : null,
        trace: detail ? safeJson(run.trace) : null,
      };
    }
  }
  chain.verdict = { ...(entry.verdict as object), ...(entry.decision ? { decision: entry.decision } : {}) };

  if (row.source === "surfaces" && row.window_id) {
    const w = (await db.get("SELECT model, prompt_version FROM surface_windows WHERE id = ?", [row.window_id])) as
      | { model: string | null; prompt_version: string | null }
      | undefined;
    // A window too small to send to the model has no run, by design.
    if (w?.model) expected.add("run");
    chain.verdict.model = w?.model ?? null;
    chain.verdict.prompt_version = w?.prompt_version ?? null;
    const prop = (await db.get("SELECT id, card_kind, state, posted_at, expires_at FROM surface_proposals WHERE window_id = ?", [
      row.window_id,
    ])) as Record<string, any> | undefined;
    if (prop) {
      expected.add("proposal");
      const items = (await db.all(
        `SELECT id, item_kind, op, title, state, edited, review_id, node_id, version, decided_by_user_id, decided_at, reason
           FROM surface_proposal_items WHERE proposal_id = ? AND state <> 'dropped' ORDER BY created_at`,
        [prop.id],
      )) as Array<Record<string, any>>;
      chain.proposal = {
        id: prop.id,
        card_kind: prop.card_kind,
        state: prop.state,
        posted_at: prop.posted_at,
        expires_at: prop.expires_at,
        items: items.map((i) => ({
          id: i.id,
          kind: i.item_kind,
          op: i.op,
          ...(n1 ? {} : { title: i.title }),
          state: i.state,
          edited: !!i.edited,
          review_id: i.review_id,
        })),
      };
      const decided = items.find((i) => i.decided_at);
      if (decided) {
        expected.add("review");
        chain.review = {
          state: decided.state === "approved" && decided.edited ? "edited" : decided.state,
          ...(n1 ? {} : { by: await emailOf(decided.decided_by_user_id), reason: decided.reason ?? null }),
          at: decided.decided_at,
        };
      }
    }
    const commit = (await db.get(
      `SELECT c.node_id, c.version, c.review_id, c.edited, c.created_at, c.conversation_id, u.email AS approver
         FROM surface_commits c LEFT JOIN users u ON u.id = c.approved_by_user_id
        WHERE c.window_id = ? ORDER BY c.created_at DESC LIMIT 1`,
      [row.window_id],
    )) as Record<string, any> | undefined;
    if (commit) {
      expected.add("version").add("source").add("review").add("proposal").add("run");
      chain.version = {
        ...(n1 ? {} : { node_id: commit.node_id, saved_by: commit.approver ?? null }),
        version: commit.version == null ? null : Number(commit.version),
        edited: !!commit.edited,
        at: commit.created_at,
      };
    }
    if (!n1) chain.source = entry.source ?? null;
    else if (commit || prop) chain.source = { kind: "surface", label: PRIVATE_CONVERSATION };
  } else if (row.run_id) {
    expected.add("run");
    const reviews = (await db.all(
      `SELECT id, node_id, version, status, requested_by, requested_at, resolved_by, resolved_at, resolution_note
         FROM review_requests WHERE run_id = ? ORDER BY requested_at`,
      [row.run_id],
    )) as Array<Record<string, any>>;
    if (reviews.length) {
      expected.add("proposal");
      const rr = reviews.find((x) => x.status === "approved") ?? reviews.find((x) => x.resolved_at) ?? reviews[0];
      chain.proposal = {
        review_id: rr.id,
        ...(n1 ? {} : { node_id: rr.node_id }),
        version: Number(rr.version),
        state: rr.status,
        requested_by: n1 ? undefined : rr.requested_by,
        requested_at: rr.requested_at,
        count: reviews.length,
      };
      if (rr.resolved_at) {
        expected.add("review");
        chain.review = { state: rr.status, ...(n1 ? {} : { by: rr.resolved_by, reason: rr.resolution_note ?? null }), at: rr.resolved_at };
      }
      if (rr.status === "approved") {
        expected.add("version").add("source");
        const v = (await db.get(
          "SELECT version, author, created_at, status FROM node_versions WHERE nest_id = ? AND node_id = ? AND version = ?",
          [nestId, rr.node_id, rr.version],
        )) as Record<string, any> | undefined;
        if (v) {
          chain.version = {
            ...(n1 ? {} : { node_id: rr.node_id, author: v.author ?? null }),
            version: Number(v.version),
            at: v.created_at,
          };
        }
      }
    }
    const runRow = chain.run as Record<string, any> | null;
    chain.source = n1
      ? { kind: "agent", label: PRIVATE_CONVERSATION }
      : row.source === "external"
        ? { kind: "agent", label: runRow?.external_ref ?? null, triggered_by: runRow?.triggered_by ?? null }
        : { kind: row.source, label: null, triggered_by: runRow?.triggered_by ?? null };
  }

  let steps: unknown[] = [];
  if (row.run_id) {
    const s = (await db.all(
      "SELECT seq, node_id, edge_id, action, detail, at FROM run_steps WHERE run_id = ? ORDER BY seq LIMIT 500",
      [row.run_id],
    )) as Array<Record<string, any>>;
    steps = s.map((x) => ({
      seq: Number(x.seq),
      action: x.action,
      node_id: n1 ? null : x.node_id,
      edge_id: x.edge_id,
      detail: detail ? safeJson(x.detail) : null,
      at: x.at,
    }));
  }
  const ORDER = ["run", "verdict", "proposal", "review", "version", "source"];
  const gaps = ORDER.filter((h) => expected.has(h) && (chain[h] === null || chain[h] === undefined));
  return { api_version: AGENT_API_VERSION, entry, chain, steps, gaps };
}

// ─── Export ────────────────────────────────────────────────────────────────

const EXPORT_MAX_ROWS = 50_000;

/** Test seam: make the next export fail mid-way (the failure is audited). */
export const ledgerTestHooks: { failExport?: boolean } = {};

/** Flatten a ledger row for CSV. */
function flat(e: Record<string, any>): Record<string, unknown> {
  return {
    entry_id: e.entry_id,
    at: e.at,
    nest_id: e.nest?.id,
    nest: e.nest?.label,
    agent_node: e.agent?.node_id,
    agent: e.agent?.name,
    agent_source: e.agent?.source,
    run_id: e.run?.id ?? null,
    outcome: e.run?.outcome ?? null,
    cost_usd: e.run?.cost_usd ?? null,
    verdict: e.verdict?.code ?? null,
    reason_code: e.verdict?.reason_code ?? null,
    message_count: e.verdict?.message_count ?? null,
    decision_summary: e.decision?.summary ?? null,
    proposal_title: e.proposal?.title ?? null,
    proposal_state: e.proposal?.state ?? null,
    proposals: e.proposal?.counts?.proposals ?? 0,
    reviewer: e.review?.by ?? null,
    review_reason: e.review?.reason ?? null,
    commit_node_id: e.commit?.node_id ?? null,
    commit_version: e.commit?.version ?? null,
    source: e.source?.label ?? null,
    source_url: e.source?.url ?? null,
    redacted: e.redacted ?? null,
  };
}

/** CSV cell: quoted, and a leading = + - @ neutralised (formula injection). */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Every row the filters match, serialised exactly as the ledger API serves
 * them (same redaction), as NDJSON or CSV. Capped at 50 000 rows. Read in
 * 200-row keyset pages whose links are batched (`hydrate`), so the query count
 * grows per page, not per row.
 */
export async function exportLedger(scope: LedgerScope, f: LedgerFilters, format: "csv" | "ndjson"): Promise<{ body: string; rows: number }> {
  const out: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const page = await listLedger(scope, { ...f, cursor, limit: 200 }, { totals: false });
    if (ledgerTestHooks.failExport) throw new Error("injected export failure");
    out.push(...page.entries);
    cursor = page.next_cursor ?? undefined;
  } while (cursor && out.length < EXPORT_MAX_ROWS);
  const rows = out.slice(0, EXPORT_MAX_ROWS);
  if (format === "ndjson") return { body: rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), rows: rows.length };
  const flatRows = rows.map(flat);
  const header = Object.keys(flat({}));
  const lines = [header.join(","), ...flatRows.map((r) => header.map((h) => csvCell(r[h])).join(","))];
  return { body: lines.join("\n") + "\n", rows: rows.length };
}
