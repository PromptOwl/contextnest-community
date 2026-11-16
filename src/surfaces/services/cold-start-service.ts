/**
 * Cold start (po-1186 CR2, AC-CR-04): how fast a seeded nest fills up.
 *
 * A read model over tables that already exist — nothing is stored:
 *   - the seed's folders: `surface_seed_items` (kind = folder), minus the
 *     seed's admin-only folders (`listener_json.admin_folders`);
 *   - what is approved in each: every document under the folder with an
 *     approval, dated by its EARLIEST approval across `review_requests`
 *     (resolved approved), the `approved_versions` pin and approved/published
 *     `node_versions` rows (compared as instants, so SQLite and ISO formats mix
 *     safely; an unparseable time is ignored). A deleted document has none of
 *     these rows (deleteNode purges them) and a moved one carries them along;
 *     EXCLUDING the documents the seed wrote itself (its CONTEXT.md and thesis,
 *     `surface_seed_items` kind node, and the root CONTEXT when it recorded
 *     kind context — matched exactly), so a seed never counts as cover;
 *   - counts are absolute (what each folder holds now, including documents
 *     approved before the seed); times are seed-relative (a folder's
 *     `first_approved_at` and the nest's `first_approved` both skip approvals
 *     from before `applied_at`, and an unparseable `applied_at` makes no time
 *     claim at all);
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
import { PRIVATE_TITLE, personalOwner, personalOwners } from "../n1.js";

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
  /** True when the seed's listener settings couldn't be read, so folder names are withheld (fail closed). */
  folders_withheld: boolean;
  coverage: { covered: number; total: number };
  first_approved: { node_id: string | null; at: string; after_seed_ms: number } | null;
  mirror: { people: { proposed: number; accepted: number }; areas: { proposed: number; accepted: number } };
  /** Approved documents in the seed's folders, cumulative, one point per UTC day from the seed to today. */
  cumulative: Array<{ day: string; approved: number }>;
  api_version: "2026-11";
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type Approval = { node_id: string; at: string | null };
type App = { nest_id: string; seed_id: string; seed_version: number; applied_at: string; listener_json: string };
type Item = { nest_id: string; kind: string; target: string };
type MirrorRow = { nest_id: string; kind: "person" | "area"; status: string | null };

/** Everything the read model needs for a set of nests: a fixed number of queries, whatever the count. */
interface Inputs {
  names: Map<string, string>;
  apps: Map<string, App[]>;
  items: Map<string, Item[]>;
  mirror: Map<string, MirrorRow[]>;
  /** The first time each document was approved, per nest. */
  approvals: Map<string, Map<string, string>>;
}

const CHUNK = 500;

async function allIn<T>(sql: (ph: string) => string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    out.push(...((await getDb().all(sql(chunk.map(() => "?").join(",")), chunk as any)) as T[]));
  }
  return out;
}

function groupBy<T extends { nest_id: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const l = m.get(r.nest_id);
    if (l) l.push(r);
    else m.set(r.nest_id, [r]);
  }
  return m;
}

async function loadInputs(nestIds: string[]): Promise<Inputs> {
  const names = new Map<string, string>();
  for (const n of await allIn<{ id: string; name: string }>((ph) => `SELECT id, name FROM nests WHERE id IN (${ph})`, nestIds)) names.set(n.id, n.name);
  const apps = groupBy(
    await allIn<App>(
      (ph) => `SELECT nest_id, seed_id, seed_version, applied_at, listener_json FROM surface_seed_applications WHERE nest_id IN (${ph}) ORDER BY applied_at, seed_id`,
      nestIds,
    ),
  );
  // Only seeded nests have folders, approvals or a mirror worth reading.
  const seeded = [...apps.keys()];
  const items = groupBy(await allIn<Item>((ph) => `SELECT nest_id, kind, target FROM surface_seed_items WHERE nest_id IN (${ph}) ORDER BY target`, seeded));
  const mirror = groupBy(
    await allIn<MirrorRow>(
      (ph) => `SELECT m.nest_id, m.kind, r.status FROM surface_seed_mirror m LEFT JOIN review_requests r ON r.id = m.review_id WHERE m.nest_id IN (${ph})`,
      seeded,
    ),
  );
  // The earliest approval per document across all three sources. SQL does
  // one MIN per document and table (one row per document, not per version),
  // over a normalised text form: as stored, a SQLite "YYYY-MM-DD HH:MM:SS"
  // sorts before an ISO "YYYY-MM-DDTHH:MM:SSZ" of the same day whatever the
  // instants, so 'T' → ' ' and the 'Z' is dropped first (every value is UTC;
  // the columns are TEXT on SQLite and Postgres). JS then takes the earliest
  // of the three sources as instants and reports it as ISO.
  // One pass per table over every seeded nest, not one per nest.
  const approvals = new Map<string, Map<string, string>>();
  const take = (rows: Array<Approval & { nest_id: string }>) => {
    for (const r of rows) {
      const t = r.at ? ms(r.at) : NaN;
      if (!Number.isFinite(t)) continue;
      let m = approvals.get(r.nest_id);
      if (!m) approvals.set(r.nest_id, (m = new Map()));
      const cur = m.get(r.node_id);
      if (cur === undefined || t < ms(cur)) m.set(r.node_id, new Date(t).toISOString());
    }
  };
  const norm = (col: string) => `MIN(REPLACE(REPLACE(${col}, 'T', ' '), 'Z', ''))`;
  take(
    await allIn((ph) => `SELECT nest_id, node_id, ${norm("resolved_at")} AS at FROM review_requests
                           WHERE nest_id IN (${ph}) AND status = 'approved' AND resolved_at IS NOT NULL GROUP BY nest_id, node_id`, seeded),
  );
  take(await allIn((ph) => `SELECT nest_id, node_id, approved_at AS at FROM approved_versions WHERE nest_id IN (${ph})`, seeded));
  take(
    await allIn((ph) => `SELECT nest_id, node_id, ${norm("created_at")} AS at FROM node_versions
                           WHERE nest_id IN (${ph}) AND status IN ('approved', 'published') GROUP BY nest_id, node_id`, seeded),
  );
  return { names, apps, items, mirror, approvals };
}

/** Comparable timestamps: SQLite's datetime('now') has no T/Z, ISO strings do. NaN when unparseable. */
function ms(at: string): number {
  return Date.parse(/[TZ]/.test(at) ? at : `${at.replace(" ", "T")}Z`);
}

/** Folder paths compare without a trailing slash: a seed item may end in "/" where a listener entry does not. */
const normFolder = (p: string) => p.replace(/\/+$/, "");

export async function coldStart(nestId: string, actorUserId: string, nowMs = Date.now()): Promise<ColdStart> {
  if (!(await canAdministerNest(nestId, actorUserId))) {
    throw new ForbiddenError("Only an owner or admin of this nest can see its cold start.");
  }
  const owner = await personalOwner(nestId);
  return build(nestId, await loadInputs([nestId]), !!owner && owner !== actorUserId, nowMs);
}

/** The read model for one nest from pre-loaded inputs (no queries; the caller checked access). */
function build(nestId: string, inp: Inputs, n1: boolean, nowMs: number): ColdStart {
  const base: ColdStart = {
    nest_id: nestId,
    nest_label: n1 ? PRIVATE_TITLE : inp.names.get(nestId) ?? nestId,
    redacted: n1 ? "n1" : null,
    no_seed: true,
    seed: null,
    folders: [],
    folders_withheld: false,
    coverage: { covered: 0, total: 0 },
    first_approved: null,
    mirror: { people: { proposed: 0, accepted: 0 }, areas: { proposed: 0, accepted: 0 } },
    cumulative: [],
    api_version: "2026-11",
  };
  const apps = inp.apps.get(nestId) ?? [];
  if (!apps.length) return base;

  // A nest can hold more than one seed application (a second seed applied
  // later). The cold start is measured from the FIRST one: `seed` and
  // `applied_at` are its, while folders and the mirror merge every
  // application, since each later seed only adds folders to the same nest.
  const first = apps[0];
  const appliedMs = ms(first.applied_at);
  const timed = Number.isFinite(appliedMs);
  const adminFolders = new Set<string>();
  let listenerUnreadable = false;
  for (const a of apps) {
    try {
      const l = JSON.parse(a.listener_json || "{}") as { admin_folders?: unknown };
      for (const f of Array.isArray(l.admin_folders) ? l.admin_folders : []) if (typeof f === "string") adminFolders.add(normFolder(f));
    } catch {
      listenerUnreadable = true;
    }
  }
  if (listenerUnreadable) {
    // Fail closed: without the admin-only list, any folder name might be one.
    console.warn(`[surfaces] cold start: unreadable listener_json for nest ${nestId}; folder names withheld`);
  }
  const items = inp.items.get(nestId) ?? [];
  const folderPaths = listenerUnreadable ? [] : items.filter((i) => i.kind === "folder" && !adminFolders.has(normFolder(i.target))).map((i) => i.target);
  // What the seed wrote itself never counts as cover: exactly the documents
  // it recorded (kind node), and — when it wrote the nest's instructions (kind
  // context) — the root CONTEXT document. A CONTEXT document a person writes
  // in a folder later is theirs, and counts.
  const seedNodes = new Set(items.filter((i) => i.kind === "node").map((i) => i.target.replace(/^nodes\//, "")));
  const seedContext = items.some((i) => i.kind === "context");
  const isSeedOwn = (rel: string) => seedNodes.has(rel) || (seedContext && /^CONTEXT(\.md)?$/i.test(rel));

  // Each approved document is placed in every seed folder above it by walking
  // its own path (depth), not by testing it against every folder.
  const dirs = new Map<string, ColdStartFolder>();
  const folders: ColdStartFolder[] = folderPaths.map((path) => {
    const f: ColdStartFolder = { path, approved: 0, first_approved_at: null };
    dirs.set(normFolder(path), f);
    return f;
  });
  const unique = new Map<string, string>();
  for (const [nodeId, at] of inp.approvals.get(nestId) ?? []) {
    const rel = nodeId.replace(/^nodes\//, "");
    if (isSeedOwn(rel)) continue;
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const f = dirs.get(parts.slice(0, i).join("/"));
      if (!f) continue;
      f.approved += 1;
      // Seed-relative, like first_approved below: an approval from before the seed isn't the seed's doing.
      if (timed && ms(at) >= appliedMs && (!f.first_approved_at || ms(at) < ms(f.first_approved_at))) f.first_approved_at = at;
      // A document sits in one folder, but nested seed folders list it twice.
      unique.set(nodeId, at);
    }
  }
  let firstApproved: ColdStart["first_approved"] = null;
  for (const [nodeId, at] of unique) {
    if (!timed || ms(at) < appliedMs) continue; // approved before the seed: not the seed's doing
    if (!firstApproved || ms(at) < ms(firstApproved.at)) firstApproved = { node_id: n1 ? null : nodeId, at, after_seed_ms: ms(at) - appliedMs };
  }

  const mirror = { people: { proposed: 0, accepted: 0 }, areas: { proposed: 0, accepted: 0 } };
  for (const r of inp.mirror.get(nestId) ?? []) {
    const m = r.kind === "person" ? mirror.people : mirror.areas;
    m.proposed += 1;
    if (r.status === "approved") m.accepted += 1;
  }

  // Cumulative approved documents in the seed's folders, per UTC day since the
  // seed. A seed older than MAX_DAYS is drawn from its last MAX_DAYS days: the
  // start is clamped first (approvals before it count into `before`), so an
  // old seed doesn't walk every day since it was applied.
  const MAX_DAYS = 400;
  const endDay = Date.parse(`${isoDay(nowMs)}T00:00:00.000Z`);
  const startDay = Math.max(Date.parse(`${isoDay(timed ? appliedMs : nowMs)}T00:00:00.000Z`), endDay - (MAX_DAYS - 1) * DAY_MS);
  const perDay = new Map<string, number>();
  let before = 0;
  for (const at of unique.values()) {
    const t = ms(at);
    if (t < startDay) before += 1;
    else perDay.set(isoDay(t), (perDay.get(isoDay(t)) ?? 0) + 1);
  }
  const cumulative: ColdStart["cumulative"] = [];
  let running = before;
  for (let d = startDay; d <= endDay; d += DAY_MS) {
    running += perDay.get(isoDay(d)) ?? 0;
    cumulative.push({ day: isoDay(d), approved: running });
  }

  return {
    ...base,
    no_seed: false,
    seed: { id: first.seed_id, version: Number(first.seed_version), applied_at: first.applied_at },
    folders,
    folders_withheld: listenerUnreadable,
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
 * about how a team nest fills up. Access is checked once per nest here, and
 * the data for every nest is read in one batch (`loadInputs`), so the cost no
 * longer grows by a full scan per nest.
 */
export async function coldStartAll(actorUserId: string, nowMs = Date.now()): Promise<ColdStart[]> {
  const db = getDb();
  const nestIds = ((await db.all("SELECT DISTINCT nest_id FROM surface_seed_applications ORDER BY nest_id", [])) as Array<{ nest_id: string }>).map(
    (r) => r.nest_id,
  );
  const admin = await isOrgAdmin(actorUserId);
  const owners = await personalOwners(nestIds);
  const visible: string[] = [];
  for (const id of nestIds) {
    const owner = owners.get(id);
    if (owner && owner !== actorUserId) continue;
    if (!admin && !(await canAdministerNest(id, actorUserId))) continue;
    visible.push(id);
  }
  if (!visible.length) return [];
  const inp = await loadInputs(visible);
  // Personal nests left in are the caller's own: never redacted.
  return visible.map((id) => build(id, inp, false, nowMs));
}
