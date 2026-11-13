/**
 * Rollups (po-1186 CR1): the decision ledger grouped by day or ISO week and
 * by agent, nest or binding. Computed on read over exactly the rows the
 * ledger serves — same predicate builder, same SQL tally (the database groups
 * by day; this folds days into weeks and keys) — so every bucket equals
 * the ledger `totals` for that bucket's range and filters, and the buckets
 * sum to the range total (AC-CR-10). No cache: research §5 defers one until
 * the read is measured slow, and then only as a rebuildable derivative.
 */
import { getDb } from "../db/client.js";
import { PRIVATE_CONVERSATION, PRIVATE_TITLE, n1Redacts, personalOwners } from "../surfaces/n1.js";
import { AGENT_API_VERSION } from "../workflow/agent-event-schema.js";
import {
  addToTally,
  aggregateRows,
  emptyTally,
  finishTally,
  type LedgerFilters,
  type LedgerScope,
  type Tally,
} from "./ledger-service.js";

export type Grain = "day" | "week";
export type GroupBy = "agent" | "nest" | "binding" | "reason" | "none";

/** UTC day of an ISO timestamp, or the Monday of its ISO week. */
export function bucketOf(at: string, grain: Grain): string {
  const day = at.slice(0, 10);
  if (grain === "day") return day;
  const d = new Date(`${day}T00:00:00.000Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export interface RollupRow extends Tally {
  bucket: string;
  key: string;
  label: string | null;
  /** The nest the key belongs to (by agent / binding / nest); null for by=reason and by=none. */
  nest_id: string | null;
  /** The latest ledger row in the group (po-1186 CR2: "last report", "last activity"). */
  last_at: string;
  /** That latest row's source (surfaces | metacognition | runner | external): what kind of agent it is. */
  source: string;
}

export async function rollups(
  scope: LedgerScope,
  f: LedgerFilters & { grain?: Grain; by?: GroupBy },
  reconcilesWith: string,
): Promise<{
  api_version: string;
  grain: Grain;
  by: GroupBy;
  range: { from: string; to: string };
  rows: RollupRow[];
  totals: Tally;
  reconciles_with: string;
}> {
  const grain: Grain = f.grain ?? "day";
  const by: GroupBy = f.by ?? "agent";
  // q is a ledger-page search, not a rollup dimension.
  const { rows, range } = await aggregateRows(scope, { ...f, q: undefined });
  const owners = await personalOwners(scope.nestIds);
  const groups = new Map<string, { bucket: string; key: string; nestId: string; lastAt: string; source: string; tally: ReturnType<typeof emptyTally> }>();
  const total = emptyTally();
  for (const r of rows) {
    const key =
      by === "agent"
        ? r.agent_node ?? "(none)"
        : by === "nest"
          ? r.nest_id
          : by === "binding"
            ? r.binding_id ?? "(none)"
            : by === "reason"
              ? r.reason_code ?? "(none)"
              : "all";
    // r is already a SQL aggregate (one UTC day × nest × agent × binding × source × reason).
    const bucket = bucketOf(r.day, grain);
    const id = `${bucket}\u0000${by === "agent" || by === "binding" ? `${r.nest_id}\u0000${key}` : key}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { bucket, key, nestId: r.nest_id, lastAt: r.last_at, source: r.source, tally: emptyTally() }));
    if (r.last_at > g.lastAt) (g.lastAt = r.last_at), (g.source = r.source);
    addToTally(g.tally, r);
    addToTally(total, r);
  }
  const db = getDb();
  const labelCache = new Map<string, string | null>();
  const labelOf = async (g: { key: string; nestId: string }): Promise<string | null> => {
    const ck = `${by}\u0000${g.nestId}\u0000${g.key}`;
    if (labelCache.has(ck)) return labelCache.get(ck)!;
    let label: string | null = null;
    const n1 = n1Redacts(owners, g.nestId, scope.viewerUserId);
    if (by === "agent") {
      const row = (await db.get("SELECT title FROM node_index WHERE nest_id = ? AND node_id = ?", [g.nestId, g.key])) as
        | { title: string }
        | undefined;
      label = row?.title || g.key.split("/").pop() || g.key;
    } else if (by === "nest") {
      const row = (await db.get("SELECT name FROM nests WHERE id = ?", [g.key])) as { name: string } | undefined;
      label = n1 ? PRIVATE_TITLE : row?.name ?? g.key;
    } else if (by === "binding") {
      const row = (await db.get("SELECT conversation_name FROM surface_bindings WHERE id = ?", [g.key])) as
        | { conversation_name: string | null }
        | undefined;
      label = n1 ? PRIVATE_CONVERSATION : row?.conversation_name ? `#${row.conversation_name}` : null;
    }
    labelCache.set(ck, label);
    return label;
  };
  const out: RollupRow[] = [];
  for (const g of groups.values()) {
    out.push({
      bucket: g.bucket,
      key: g.key,
      label: await labelOf(g),
      nest_id: by === "none" || by === "reason" ? null : g.nestId,
      last_at: g.lastAt,
      source: g.source,
      ...finishTally(g.tally),
    });
  }
  out.sort((a, b) => (a.bucket === b.bucket ? a.key.localeCompare(b.key) : a.bucket < b.bucket ? -1 : 1));
  return {
    api_version: AGENT_API_VERSION,
    grain,
    by,
    range,
    rows: out,
    totals: finishTally(total),
    reconciles_with: reconcilesWith,
  };
}
