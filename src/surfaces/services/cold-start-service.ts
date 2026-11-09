/**
 * Cold start (po-1186 CR2, AC-CR-04): how fast a seeded nest fills up.
 *
 * A read model over tables that already exist — nothing is stored:
 *   - the seed's folders: `surface_seed_items` (kind = folder), minus the
 *     seed's admin-only folders (`listener_json.admin_folders`);
 *   - what is approved in each: the first approved version of every document
 *     under the folder (`review_requests` resolved approved, else the
 *     `approved_versions` pin, else an approved/published `node_versions` row),
 *     EXCLUDING the documents the seed wrote itself (its CONTEXT.md and thesis,
 *     `surface_seed_items` kind node/context), so a seed never counts as cover;
 *   - time to the first approved document = that first approval − the seed's
 *     `applied_at`;
 *   - the org mirror (people and areas): `surface_seed_mirror` × the status of
 *     the review it opened.
 *
 * Owner/admin of the nest only (a server admin may read any nest). N1: a
 * personal (DM) nest's label is hidden from anyone but its owner; folder names
 * are the seed's own, and the figures are counts, so they stay.
 */
import { getDb } from "../../db/client.js";
import { ForbiddenError } from "../../shared/errors.js";
import { canAdministerNest, isOrgAdmin } from "./binding-service.js";
import { PRIVATE_TITLE, personalOwner } from "../n1.js";

export interface ColdStartFolder {
  path: string;
  approved: number;
  first_approved_at: string | null;
}

export interface ColdStart {
  nest_id: string;
  nest_label: string;
  redacted: "n1" | null;
  no_seed: boolean;
  seed: { id: string; version: number; applied_at: string } | null;
  folders: ColdStartFolder[];
  coverage: { covered: number; total: number };
  first_approved: { node_id: string | null; at: string; after_seed_ms: number } | null;
  mirror: { people: { proposed: number; accepted: number }; areas: { proposed: number; accepted: number } };
  /** Approved documents in the seed's folders, cumulative, one point per UTC day from the seed to today. */
  cumulative: Array<{ day: string; approved: number }>;
  api_version: "2026-11";
}

const DAY_MS = 86_400_000;
/** Same rule as nodes/service isIdUnderFolder (ids may or may not carry the nodes/ prefix). */
const isIdUnderFolder = (id: string, folder: string) => id.startsWith(`nodes/${folder}/`) || id.startsWith(`${folder}/`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The first time each document in the nest was approved. */
async function firstApprovals(nestId: string): Promise<Map<string, string>> {
  const db = getDb();
  const out = new Map<string, string>();
  const take = (rows: Array<{ node_id: string; at: string | null }>) => {
    for (const r of rows) {
      if (!r.at || out.has(r.node_id)) continue;
      out.set(r.node_id, r.at);
    }
  };
  // Precedence: the review decision's time, then the pin, then the version row.
  take(
    (await db.all(
      "SELECT node_id, MIN(resolved_at) AS at FROM review_requests WHERE nest_id = ? AND status = 'approved' AND resolved_at IS NOT NULL GROUP BY node_id",
      [nestId],
    )) as Array<{ node_id: string; at: string | null }>,
  );
  take((await db.all("SELECT node_id, approved_at AS at FROM approved_versions WHERE nest_id = ?", [nestId])) as Array<{ node_id: string; at: string | null }>);
  take(
    (await db.all(
      "SELECT node_id, MIN(created_at) AS at FROM node_versions WHERE nest_id = ? AND status IN ('approved', 'published') GROUP BY node_id",
      [nestId],
    )) as Array<{ node_id: string; at: string | null }>,
  );
  return out;
}

/** Comparable timestamps: SQLite's datetime('now') has no T/Z, ISO strings do. */
function ms(at: string): number {
  const t = Date.parse(/[TZ]/.test(at) ? at : `${at.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : 0;
}

export async function coldStart(nestId: string, actorUserId: string, nowMs = Date.now()): Promise<ColdStart> {
  if (!(await canAdministerNest(nestId, actorUserId))) {
    throw new ForbiddenError("Only an owner or admin of this nest can see its cold start.");
  }
  const db = getDb();
  const owner = await personalOwner(nestId);
  const n1 = !!owner && owner !== actorUserId;
  const nest = (await db.get("SELECT name FROM nests WHERE id = ?", [nestId])) as { name: string } | undefined;
  const base: ColdStart = {
    nest_id: nestId,
    nest_label: n1 ? PRIVATE_TITLE : nest?.name ?? nestId,
    redacted: n1 ? "n1" : null,
    no_seed: true,
    seed: null,
    folders: [],
    coverage: { covered: 0, total: 0 },
    first_approved: null,
    mirror: { people: { proposed: 0, accepted: 0 }, areas: { proposed: 0, accepted: 0 } },
    cumulative: [],
    api_version: "2026-11",
  };
  const apps = (await db.all(
    "SELECT seed_id, seed_version, applied_at, listener_json FROM surface_seed_applications WHERE nest_id = ? ORDER BY applied_at, seed_id",
    [nestId],
  )) as Array<{ seed_id: string; seed_version: number; applied_at: string; listener_json: string }>;
  if (!apps.length) return base;

  const first = apps[0];
  const appliedMs = ms(first.applied_at);
  const adminFolders = new Set<string>();
  for (const a of apps) {
    try {
      const l = JSON.parse(a.listener_json || "{}") as { admin_folders?: unknown };
      for (const f of Array.isArray(l.admin_folders) ? l.admin_folders : []) if (typeof f === "string") adminFolders.add(f);
    } catch {
      /* a malformed listener hides nothing extra */
    }
  }
  const items = (await db.all("SELECT kind, target FROM surface_seed_items WHERE nest_id = ? ORDER BY target", [nestId])) as Array<{
    kind: string;
    target: string;
  }>;
  const folderPaths = items.filter((i) => i.kind === "folder" && !adminFolders.has(i.target)).map((i) => i.target);
  // What the seed wrote itself never counts as cover (its CONTEXT.md, thesis).
  const seedNodes = new Set(items.filter((i) => i.kind === "node").map((i) => i.target.replace(/^nodes\//, "")));
  const isSeedOwn = (nodeId: string) => {
    const rel = nodeId.replace(/^nodes\//, "");
    return seedNodes.has(rel) || /(^|\/)CONTEXT(\.md)?$/i.test(rel);
  };

  const approvals = await firstApprovals(nestId);
  const counted: Array<{ node_id: string; at: string }> = [];
  const folders: ColdStartFolder[] = folderPaths.map((path) => {
    const dir = path.replace(/\/$/, "");
    let n = 0;
    let firstAt: string | null = null;
    for (const [nodeId, at] of approvals) {
      if (isSeedOwn(nodeId) || !isIdUnderFolder(nodeId, dir)) continue;
      n += 1;
      if (!firstAt || ms(at) < ms(firstAt)) firstAt = at;
      counted.push({ node_id: nodeId, at });
    }
    return { path, approved: n, first_approved_at: firstAt };
  });
  // A document sits in one folder, but nested seed folders could list it twice.
  const unique = new Map(counted.map((c) => [c.node_id, c.at]));
  let firstApproved: ColdStart["first_approved"] = null;
  for (const [nodeId, at] of unique) {
    if (ms(at) < appliedMs) continue; // approved before the seed: not the seed's doing
    if (!firstApproved || ms(at) < ms(firstApproved.at)) firstApproved = { node_id: n1 ? null : nodeId, at, after_seed_ms: ms(at) - appliedMs };
  }

  const mirrorRows = (await db.all(
    `SELECT m.kind, r.status FROM surface_seed_mirror m LEFT JOIN review_requests r ON r.id = m.review_id WHERE m.nest_id = ?`,
    [nestId],
  )) as Array<{ kind: "person" | "area"; status: string | null }>;
  const mirror = { people: { proposed: 0, accepted: 0 }, areas: { proposed: 0, accepted: 0 } };
  for (const r of mirrorRows) {
    const m = r.kind === "person" ? mirror.people : mirror.areas;
    m.proposed += 1;
    if (r.status === "approved") m.accepted += 1;
  }

  // Cumulative approved documents in the seed's folders, per UTC day since the seed.
  const startDay = Date.parse(`${isoDay(appliedMs || nowMs)}T00:00:00.000Z`);
  const endDay = Date.parse(`${isoDay(nowMs)}T00:00:00.000Z`);
  const perDay = new Map<string, number>();
  let before = 0;
  for (const at of unique.values()) {
    const t = ms(at);
    if (t < startDay) before += 1;
    else perDay.set(isoDay(t), (perDay.get(isoDay(t)) ?? 0) + 1);
  }
  let cumulative: ColdStart["cumulative"] = [];
  let running = before;
  for (let d = startDay; d <= endDay; d += DAY_MS) {
    running += perDay.get(isoDay(d)) ?? 0;
    cumulative.push({ day: isoDay(d), approved: running });
  }
  // A seed older than ~a year is drawn from its last 400 days.
  if (cumulative.length > 400) cumulative = cumulative.slice(-400);

  return {
    ...base,
    no_seed: false,
    seed: { id: first.seed_id, version: Number(first.seed_version), applied_at: first.applied_at },
    folders,
    coverage: { covered: folders.filter((f) => f.approved > 0).length, total: folders.length },
    first_approved: firstApproved,
    mirror,
    cumulative,
  };
}

/**
 * Every seeded nest the caller administers (all seeded nests for a server
 * admin), each with its cold start. Personal (DM) nests are left out for
 * anyone but their owner: they carry the default seed and say nothing useful
 * about how a team nest fills up.
 */
export async function coldStartAll(actorUserId: string, nowMs = Date.now()): Promise<ColdStart[]> {
  const db = getDb();
  const nestIds = ((await db.all("SELECT DISTINCT nest_id FROM surface_seed_applications ORDER BY nest_id", [])) as Array<{ nest_id: string }>).map(
    (r) => r.nest_id,
  );
  const admin = await isOrgAdmin(actorUserId);
  const out: ColdStart[] = [];
  for (const id of nestIds) {
    if (!admin && !(await canAdministerNest(id, actorUserId))) continue;
    const owner = await personalOwner(id);
    if (owner && owner !== actorUserId) continue;
    out.push(await coldStart(id, actorUserId, nowMs));
  }
  return out;
}
