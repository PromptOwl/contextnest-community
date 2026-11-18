/**
 * Context pull log (po-1252) — the Graph view's retrieval replay, and the MCP
 * `context_pull_log` tool.
 *
 * A read model over the access log (node_access_events, access-log.ts), never
 * a log of its own. Every retrieval call already leaves one row per document
 * it handed over; since migration 093 those rows share a `pull_id` and carry
 * their place in the payload (`seq`), size (`bytes`) and, where the server ran
 * the traversal, hop depth (`hop`) and the document they were reached from
 * (`via`). This groups them back into pulls, newest first. Rows written before
 * 093 have no pull_id: one call's rows share a timestamp, caller and tool, so
 * they are grouped on that and read back without order, size or hops. That
 * grouping is best effort: two identical calls in the same millisecond merge,
 * and a `legacy-<id>` id changes if retention prunes the group's first row.
 *
 * Reads and retrievals only — an export hands over the whole nest, which is
 * not a traversal worth replaying.
 *
 * Who sees what (the route and the tool share pullViewer):
 *   - every step is gated by filterAccessible: a scoped reader never sees a
 *     document they can't read, and a pull with nothing readable is left out;
 *   - the person and the agent are shown only to callers who can see editors
 *     (write and up, not a visibility-only reader) — the rule the graph's
 *     steward overlay uses. Below that the agent filter matches nothing, so
 *     it can't be used to probe for who pulled;
 *   - a visibility-only (public / org) reader gets no versions or titles:
 *     both come from history and the working copy they have no access to.
 *     The Graph view labels steps from the graph it already drew.
 */
import { getDb } from "../db/client.js";
import { deserializeClient } from "../shared/client-metadata.js";
import { isPublicReader, permissionLevel, resolveNestPermission } from "../shared/access.js";
import { filterAccessible } from "./access-guard.js";
import { MAX_PER_CALL, readAccessLogSetting } from "./access-log.js";
import { buildTitleMap } from "./title-resolver.js";

export interface PullStep {
  /** Place in the payload, 0-based. */
  seq: number;
  nodeId: string;
  title: string | null;
  /** The version served; null where unknown or hidden from this caller. */
  version: number | null;
  /** Links from a match (0 = it matched); null where the server didn't walk. */
  hop: number | null;
  /** The document this one was reached from. */
  via: string | null;
  bytes: number | null;
}

export interface Pull {
  id: string;
  at: string;
  /** The surface's own name for the call: context_get, search, context… */
  tool: string | null;
  surface: "api" | "mcp";
  action: "read" | "retrieve";
  /** The account that pulled; null when this caller may not see editors. */
  actor: string | null;
  /** The agent named in the caller's attribution; same rule as actor. */
  agent: string | null;
  documents: number;
  /** Bytes handed over, summed over steps that know their size. */
  bytes: number | null;
  maxHop: number | null;
  steps: PullStep[];
}

export interface PullPage {
  pulls: Pull[];
  hasMore: boolean;
  /** Pass as `before` for the next page. */
  nextBefore: string | null;
  /** False when the nest's owner turned access logging off. */
  accessLogEnabled: boolean;
  /** Whether actor/agent are shown to this caller. */
  identities: boolean;
}

export interface PullViewer {
  userId: string;
  userEmail: string;
  identities: boolean;
  publicReader: boolean;
}

export const MAX_PULLS = 50;
/** Rows read per window: enough for a full page of maximum-size pulls. */
const MAX_ROWS = 2500;
/** Windows read for one page before handing back a cursor instead. */
const MAX_WINDOWS = 4;

/** A database without the access log, or without migration 093's columns —
 *  SQLite's "no such table/column", Postgres's "… does not exist" — and
 *  nothing else: an unrelated missing table or column is a fault to surface,
 *  not an empty log. */
const PULL_SCHEMA = /node_access_events|\b(?:e\.)?(?:pull_id|seq|hop|via|bytes)\b/i;
export function isMissingSchemaError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /no such (table|column)|does not exist/i.test(msg) && PULL_SCHEMA.test(msg);
}

interface Row {
  id: number | string;
  ts: string;
  node_id: string;
  action: "read" | "retrieve";
  surface: "api" | "mcp";
  user_id: string | null;
  client_json: string | null;
  detail: string | null;
  version: number | null;
  agent: string | null;
  pull_id: string | null;
  seq: number | null;
  hop: number | null;
  via: string | null;
  bytes: number | null;
  actor: string | null;
}

const COLUMNS = `e.id, e.ts, e.node_id, e.action, e.surface, e.user_id, e.client_json, e.detail, e.version,
  e.agent, e.pull_id, e.seq, e.hop, e.via, e.bytes, COALESCE(e.user_email, u.email, e.user_id) AS actor`;
const FROM = "FROM node_access_events e LEFT JOIN users u ON u.id = e.user_id";

export async function pullViewer(
  nestId: string,
  userId: string,
  userEmail: string,
  opts: { readOnlyKey?: boolean } = {},
): Promise<PullViewer> {
  const [permission, publicReader] = await Promise.all([
    resolveNestPermission(nestId, userId),
    isPublicReader(nestId, userId),
  ]);
  return {
    userId,
    userEmail,
    publicReader,
    // A read-only key reads, whatever its owner may do (the same clamp as REST
    // and the other MCP tools), so it is never shown who pulled.
    identities: !publicReader && !opts.readOnlyKey && permissionLevel(permission) >= permissionLevel("write"),
  };
}

/** Group key: the pull id, or for a pre-093 row the call it came from. */
const groupKey = (r: Row) =>
  r.pull_id ?? `legacy|${r.ts}|${r.actor ?? ""}|${r.action}|${r.surface}|${r.detail ?? ""}|${r.agent ?? ""}`;

const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Titles for one request, loaded at most once however many slices it builds. */
type TitleSource = () => Promise<Map<string, string>>;

function titleSource(nestId: string, viewer: PullViewer): TitleSource {
  let titles: Promise<Map<string, string>> | null = null;
  return () => (titles ??= viewer.publicReader ? Promise.resolve(new Map()) : buildTitleMap(nestId));
}

async function build(
  nestId: string,
  viewer: PullViewer,
  groups: Row[][],
  titlesOf: TitleSource = titleSource(nestId, viewer),
): Promise<Pull[]> {
  const ids = [...new Set(groups.flatMap((g) => g.map((r) => r.node_id)))];
  const readable = new Set(
    (await filterAccessible(nestId, viewer.userId, viewer.userEmail, ids.map((id) => ({ id })))).map((n) => n.id),
  );
  if (!readable.size) return [];
  const titles = await titlesOf();
  const pulls: Pull[] = [];
  for (const rows of groups) {
    // Payload order where recorded; insertion order otherwise.
    const ordered = [...rows].sort(
      (a, b) => (num(a.seq) ?? Infinity) - (num(b.seq) ?? Infinity) || Number(a.id) - Number(b.id),
    );
    const steps: PullStep[] = ordered
      .filter((r) => readable.has(r.node_id))
      .map((r, i) => ({
        seq: num(r.seq) ?? i,
        nodeId: r.node_id,
        title: titles.get(r.node_id) ?? null,
        version: viewer.publicReader ? null : num(r.version),
        hop: num(r.hop),
        // A step reached from a document this caller can't read names nothing.
        via: r.via && readable.has(r.via) ? r.via : null,
        bytes: num(r.bytes),
      }));
    if (!steps.length) continue;
    const head = ordered[0];
    const sizes = steps.map((s) => s.bytes).filter((b): b is number => b != null);
    const hops = steps.map((s) => s.hop).filter((h): h is number => h != null);
    const client = deserializeClient(head.client_json);
    const agent = typeof client?.agent === "string" && client.agent ? client.agent : head.agent;
    pulls.push({
      id: head.pull_id ?? `legacy-${Math.min(...rows.map((r) => Number(r.id)))}`,
      at: head.ts,
      tool: head.detail,
      surface: head.surface,
      action: head.action,
      actor: viewer.identities ? head.actor : null,
      agent: viewer.identities ? agent ?? null : null,
      documents: steps.length,
      bytes: sizes.length ? sizes.reduce((n, b) => n + b, 0) : null,
      maxHop: hops.length ? Math.max(...hops) : null,
      steps,
    });
  }
  return pulls;
}

export async function listPulls(params: {
  nestId: string;
  viewer: PullViewer;
  limit?: number;
  /** Cursor from a previous page's nextBefore. */
  before?: string;
  agent?: string;
}): Promise<PullPage> {
  const { nestId, viewer } = params;
  const limit = Math.min(Math.max(Math.floor(Number(params.limit)) || 20, 1), MAX_PULLS);
  const accessLogEnabled = await readAccessLogSetting(nestId);
  const empty: PullPage = { pulls: [], hasMore: false, nextBefore: null, accessLogEnabled, identities: viewer.identities };
  const agent = params.agent?.trim().toLowerCase() || undefined;
  // The agent is an identity: below "can see editors" a filter on it would
  // answer "did agent X pull here" — so it matches nothing.
  if (agent && !viewer.identities) return empty;
  const before = params.before != null && params.before !== "" ? Number(params.before) : undefined;
  if (before !== undefined && !Number.isFinite(before)) return empty;

  const where = ["e.nest_id = ?", "e.action IN ('read', 'retrieve')", "e.node_id IS NOT NULL"];
  const args: Array<string | number> = [nestId];
  if (agent) {
    where.push("e.agent = ?");
    args.push(agent);
  }
  // Each window holds a full page of maximum-size pulls (MAX_PER_CALL rows
  // each) plus one, so a window always holds at least two pulls and the cut
  // one below can be left to the next page.
  const window = Math.min((limit + 1) * MAX_PER_CALL, MAX_ROWS);
  const pulls: Pull[] = [];
  const titlesOf = titleSource(nestId, viewer);
  let cursor = before;
  let hasMore = false;
  let lastMin: number | null = null;
  // A window can be all pulls this caller can't read (a public reader under a
  // busy agent working in drafts). Read on, a bounded number of windows, so a
  // page isn't empty while readable pulls sit just below it. If it still is,
  // hasMore and nextBefore let the client carry on from there.
  for (let pass = 0; pass < MAX_WINDOWS && pulls.length < limit; pass++) {
    const passWhere = cursor !== undefined ? [...where, "e.id < ?"] : where;
    const passArgs = cursor !== undefined ? [...args, cursor] : args;
    let rows: Row[];
    try {
      rows = (await getDb().all(
        `SELECT ${COLUMNS} ${FROM} WHERE ${passWhere.join(" AND ")} ORDER BY e.id DESC LIMIT ?`,
        [...passArgs, window],
      )) as Row[];
    } catch (err) {
      // A database without the access log (or migration 093) has no pulls.
      if (isMissingSchemaError(err)) return empty;
      throw err;
    }
    const groups = new Map<string, Row[]>();
    for (const r of rows) {
      const k = groupKey(r);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    let ordered = [...groups.values()];
    // A full window may have cut the oldest pull in half; leave it to the next
    // page, which starts below the last pull returned. (Only a window that
    // holds one pull keeps it, and MAX_PER_CALL keeps a pull below a window.)
    const windowFull = rows.length === window;
    if (windowFull && ordered.length > 1) ordered = ordered.slice(0, -1);

    let consumed = 0;
    // Build in slices so a page of pulls this caller can't see still fills up.
    while (consumed < ordered.length && pulls.length < limit) {
      const slice = ordered.slice(consumed, consumed + (limit - pulls.length));
      consumed += slice.length;
      pulls.push(...(await build(nestId, viewer, slice, titlesOf)));
      lastMin = Math.min(...slice.flatMap((g) => g.map((r) => Number(r.id))));
    }
    hasMore = consumed < ordered.length || windowFull;
    if (!hasMore || lastMin == null) break;
    cursor = lastMin;
  }
  return {
    pulls,
    hasMore,
    nextBefore: hasMore && lastMin != null ? String(lastMin) : null,
    accessLogEnabled,
    identities: viewer.identities,
  };
}

export async function getPull(params: { nestId: string; viewer: PullViewer; pullId: string }): Promise<Pull | null> {
  const { nestId, viewer, pullId } = params;
  if (!pullId || pullId.length > 100) return null;
  const db = getDb();
  let rows: Row[] = [];
  try {
    const legacy = /^legacy-(\d+)$/.exec(pullId);
    if (legacy) {
      const head = (await db.get(
        `SELECT ${COLUMNS} ${FROM} WHERE e.nest_id = ? AND e.id = ? AND e.pull_id IS NULL
            AND e.action IN ('read', 'retrieve') AND e.node_id IS NOT NULL`,
        [nestId, Number(legacy[1])],
      )) as Row | undefined;
      if (head) {
        const same = (await db.all(
          `SELECT ${COLUMNS} ${FROM} WHERE e.nest_id = ? AND e.ts = ? AND e.pull_id IS NULL
              AND e.action = ? AND e.surface = ? AND e.node_id IS NOT NULL`,
          [nestId, head.ts, head.action, head.surface],
        )) as Row[];
        rows = same.filter((r) => groupKey(r) === groupKey(head));
        // The id names the group's first row; anything else is not this pull.
        if (Math.min(...rows.map((r) => Number(r.id))) !== Number(legacy[1])) rows = [];
      }
    } else {
      rows = (await db.all(
        `SELECT ${COLUMNS} ${FROM} WHERE e.nest_id = ? AND e.pull_id = ?
            AND e.action IN ('read', 'retrieve') AND e.node_id IS NOT NULL`,
        [nestId, pullId],
      )) as Row[];
    }
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
  if (!rows.length) return null;
  return (await build(nestId, viewer, [rows]))[0] ?? null;
}

/** Plain-text summary for MCP prose. */
export function describePull(p: Pull): string {
  const name = p.agent ? `${p.agent}${p.actor ? ` (${p.actor})` : ""}` : p.actor;
  // Without identities there is no one to name — say what was pulled, not "by someone".
  const who = name ? ` by ${name}` : "";
  const size = p.bytes != null ? `, ${formatBytes(p.bytes)}` : "";
  const hops = p.maxHop != null && p.maxHop > 0 ? `, ${p.maxHop} hop${p.maxHop === 1 ? "" : "s"}` : "";
  return `${p.at} — ${p.tool ?? p.action}${who}: ${p.documents} document${p.documents === 1 ? "" : "s"}${size}${hops} [pull_id ${p.id}]`;
}

export function describeStep(s: PullStep): string {
  const v = s.version != null ? ` v${s.version}` : "";
  const size = s.bytes != null ? ` · ${formatBytes(s.bytes)}` : "";
  const how = s.hop == null ? "" : s.hop === 0 ? " · matched" : ` · hop ${s.hop}${s.via ? ` via ${s.via}` : ""}`;
  return `${s.seq + 1}. ${s.title ?? s.nodeId} (${s.nodeId})${v}${size}${how}`;
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
