/**
 * The seed engine (PRD §13): load a seed (bundled data under `seeds/`, or a
 * seed-library nest), apply it to a nest idempotently, configure the nest's
 * listeners from `manifest.listener`, and propose the org mirror through the
 * review queue.
 *
 *  - Seeds are DATA. Nothing here names a folder: folders, definitions, tags
 *    and listener settings all come from the manifest (AC-SEED-06).
 *  - A library is a GOVERNED nest (review on) a server admin lists in
 *    `seed_library_nests`. Its seeds are read with the CALLER's access, and
 *    only approved bodies AND approved titles are read (S7-R2 M2). A nest that
 *    isn't a library, isn't governed, or that the caller can't read is 404 —
 *    the same answer as "no such seed" (AC-SEED-04). The library index is
 *    cached per (library, caller) and keyed by the library's latest version.
 *  - Validation is all-or-nothing and happens before any write (AC-SEED-05).
 *    Writes are idempotent and resumable (S7-R2 L1): a failed item is
 *    reported as `failed`, the application row and the listeners are still
 *    written, and a re-run completes it.
 *  - Apply writes as the applying admin (AC-SEED-01) and records, per item,
 *    `seed_origin` and `seed_hash`; the same pair is on the version's client
 *    metadata. A current hash that differs is a human edit and is never
 *    overwritten; an item a person deleted is never re-created; a newer seed
 *    version updates an untouched item only with `upgrade: true`, by
 *    compare-and-set against what was checked (AC-SEED-02/03, S7-R2 L2).
 *  - Key writes honour the nest's push-confirmation gate (S7-R2 M1).
 *    `dry_run` plans without writing (S7-R2 M2).
 *  - One apply per nest at a time (compare-and-set claim, renewed as it runs).
 *  - The org mirror (AC-SEED-07) only ever creates drafts + review requests
 *    (submitForReview), names only, into the nest being seeded, from the
 *    conversations already bound to it with capture_ok — the guard decides.
 *    Never into a sealed nest.
 *  - A DM personal nest gets `surfaces.default_seed`, applied as its OWNER
 *    (sealed nests refuse server admins) — once; a failure backs off for a day
 *    and tells the owner once (S7-R2 L7).
 */
import { createHash, randomUUID } from "crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getDb } from "../../db/client.js";
import { ConflictError, ForbiddenError, NotFoundError, AppError } from "../../shared/errors.js";
import { resolveNestPermission, permissionLevel } from "../../shared/access.js";
import { createNode, updateNode, createEmptyFolder, vaultFolderExists, listNodesForCaller, bodyOnly } from "../../nodes/service.js";
import { engineCache } from "../../nodes/engine.js";
import { isStewardshipEnabled, nestRequiresPushConfirmation } from "../../nests/service.js";
import { isPushAllowlisted } from "../../nests/push-confirmation-service.js";
import { getApprovedVersion, getCurrentVersion } from "../../governance/version-service.js";
import { reconstructApproved } from "../../governance/approved-body.js";
import { getInstructions, writeInstructions } from "../../nests/instructions-service.js";
import { submitForReview } from "../../governance/review-service.js";
import {
  CONTEXT_TARGET,
  ROLE,
  SeedInvalidError,
  assertSeedSize,
  decideItem,
  definitionHash,
  normBody,
  parseManifest,
  seedHash,
  seedOrigin,
  type ItemAction,
  type SeedManifest,
  type SeedNodeContent,
} from "./seed-format.js";
import { canAdministerNest, UnprocessableError } from "./binding-service.js";
import { getSettings } from "./settings-service.js";
import { listenerFor, setListenerFolders } from "./listener-service.js";
import { getInstall, installRef } from "./install-store.js";
import { getConnector } from "../registry.js";
import { safeMembers } from "./members.js";
import { getProfile } from "./identity-service.js";
import { recordNotice } from "./notices.js";
import { sealedNest } from "../sealed.js";

export const CONTEXT_LABEL = "CONTEXT.md";
const CLAIM_MS = 5 * 60_000;
const SEED_NOT_FOUND = "Seed not found";
const EXCERPT_CHARS = 280;
export const DEFAULT_SEED_BACKOFF_MS = 24 * 3600_000;
export const GATED_REFUSAL =
  "This nest holds key and agent writes for confirmation. Apply this seed from a signed-in session, or from a key on the nest's allowed list.";

/** Tests only. */
export const seedTestHooks: {
  failNode?: string;
  beforeWrite?: (kind: string, target: string) => Promise<void> | void;
  onMirrorSubject?: () => Promise<void> | void;
  libraryCrawls: number;
  defaultSeedAttempts: number;
} = { libraryCrawls: 0, defaultSeedAttempts: 0 };

export interface LoadedSeed {
  manifest: SeedManifest;
  manifestText: string;
  contents: Map<string, SeedNodeContent>;
  source: "bundled" | "library";
  libraryNestId: string | null;
}

export interface SeedRef {
  id: string;
  version: number;
  title: string;
  layers: string[];
  source: "bundled" | "library";
  library_nest_id: string | null;
}

export interface ApplyItem {
  kind: "folder" | "node" | "context" | "definition";
  target: string;
  action: ItemAction;
  /** A document that landed as a draft for review (a governed nest), not published. */
  draft?: true;
  /** dry run only: what would be written. */
  title?: string;
  excerpt?: string;
}

export interface ApplyResult {
  status: "applied" | "upgraded" | "upgrade_available" | "already_applied" | "partial" | "dry_run";
  nest_id: string;
  /** How many documents written by this call landed as drafts for review (governed nests). */
  drafts: number;
  seed: { id: string; version: number; source: "bundled" | "library"; library_nest_id: string | null };
  items: ApplyItem[];
  listener: {
    propose_folders: string[];
    people_folders: string[];
    admin_folders: string[];
    domain_tags: string[];
    never_propose: string[];
    bindings_configured: number;
  };
  org_mirror: { people: number; areas: number; skipped: string | null } | null;
}

const iso = () => new Date().toISOString();
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const excerpt = (s: string) => (s.length > EXCERPT_CHARS ? `${s.slice(0, EXCERPT_CHARS)}…` : s);

// ─── loading ────────────────────────────────────────────────────────────────

let seedsDirCache: string | null | undefined;
/**
 * The bundled `seeds/` directory: the one next to THIS package's
 * package.json — the first package.json above this file. Never a parent
 * project's (INFO).
 */
export function bundledSeedsDir(): string | null {
  if (seedsDirCache !== undefined) return seedsDirCache;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) {
      const s = join(dir, "seeds");
      return (seedsDirCache = existsSync(s) && lstatSync(s).isDirectory() ? s : null);
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return (seedsDirCache = null);
}

/** A regular file, never a symlink (INFO). */
function readRegular(p: string): string | null {
  if (!existsSync(p)) return null;
  const st = lstatSync(p);
  if (!st.isFile()) return null;
  return readFileSync(p, "utf8");
}

/** A seed node file: optional frontmatter `title:`, then the body. */
function splitFile(text: string, fallbackTitle: string): SeedNodeContent {
  const t = text.replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  const title = fm ? (/^title:\s*(.+)$/m.exec(fm[1])?.[1] ?? "").trim().replace(/^["']|["']$/g, "") : "";
  return { title: title || fallbackTitle, body: normBody(fm ? t.slice(fm[0].length) : t) };
}

function loadBundled(id: string): LoadedSeed | null {
  const dir = bundledSeedsDir();
  if (!dir || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return null;
  const manifestText = readRegular(join(dir, id, "seed.md"));
  if (manifestText === null) return null;
  const manifest = parseManifest(manifestText);
  if (manifest.id !== id) throw new SeedInvalidError(`the manifest's id "${manifest.id}" doesn't match its folder "${id}"`);
  const contents = new Map<string, SeedNodeContent>();
  for (const n of manifest.nodes) {
    // parseManifest has already proven the id is slug segments under seeds/<id>/.
    const rel = n.id.slice(`seeds/${id}/`.length);
    const text = readRegular(join(dir, id, `${rel}.md`));
    if (text !== null) contents.set(n.id, splitFile(text, rel.split("/").pop()!));
  }
  assertSeedSize(manifestText, manifest, contents);
  return { manifest, manifestText, contents, source: "bundled", libraryNestId: null };
}

export function bundledSeedIds(): string[] {
  const dir = bundledSeedsDir();
  if (!dir) return [];
  return readdirSync(dir)
    .filter((d) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(d) && lstatSync(join(dir, d)).isDirectory() && readRegular(join(dir, d, "seed.md")) !== null)
    .sort();
}

/** May this user read seeds from L? A listed, governed library they can read. */
async function libraryReadable(libraryNestId: string, userId: string): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.seed_library_nests.includes(libraryNestId)) return false;
  if (!(await getDb().get("SELECT 1 AS x FROM nests WHERE id = ?", [libraryNestId]))) return false;
  if (!(await isStewardshipEnabled(libraryNestId))) return false;
  return permissionLevel(await resolveNestPermission(libraryNestId, userId)) >= permissionLevel("read");
}

/** The approved version of a library node: its title and body, or null. */
async function approvedNode(libraryNestId: string, nodeId: string): Promise<SeedNodeContent | null> {
  const approved = await getApprovedVersion(libraryNestId, nodeId);
  if (approved == null) return null;
  try {
    const { versions } = await engineCache.get(libraryNestId);
    const { raw } = await reconstructApproved(versions, libraryNestId, nodeId, approved);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    const title = fm ? (/^title:\s*(.+)$/m.exec(fm[1])?.[1] ?? "").trim().replace(/^["']|["']$/g, "") : "";
    return { title, body: normBody(bodyOnly(nodeId, raw)) };
  } catch {
    return null;
  }
}

/** A stamp that changes whenever the library's content or approvals change. */
async function libraryStamp(libraryNestId: string): Promise<string> {
  const a = (await getDb().get("SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS m FROM node_versions WHERE nest_id = ?", [libraryNestId])) as { c: number; m: number };
  const b = (await getDb().get("SELECT COUNT(*) AS c, COALESCE(SUM(approved_version), 0) AS s FROM approved_versions WHERE nest_id = ?", [libraryNestId])) as {
    c: number;
    s: number;
  };
  return `${a.c}:${a.m}:${b.c}:${b.s}`;
}

interface LibraryIndex {
  stamp: string;
  at: number;
  /** seed id → the readable seed node ids under nodes/seeds/<id>/ */
  ids: Map<string, Set<string>>;
  seeds: Map<string, LoadedSeed | Error>;
}
const INDEX_TTL_MS = 5 * 60_000;
const INDEX_MAX = 200;
const libraryIndexCache = new Map<string, LibraryIndex>();

/** The library's index for this caller, cached by (library, caller, latest version). */
async function libraryIndex(libraryNestId: string, userId: string): Promise<LibraryIndex> {
  const key = `${libraryNestId}|${userId}`;
  const stamp = await libraryStamp(libraryNestId);
  const hit = libraryIndexCache.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < INDEX_TTL_MS) return hit;
  seedTestHooks.libraryCrawls++;
  const ids = new Map<string, Set<string>>();
  for (const n of await listNodesForCaller(libraryNestId, userId, {})) {
    const m = /^nodes\/seeds\/([a-z0-9][a-z0-9-]{0,62})\/(.+)$/.exec(n.id);
    if (!m) continue;
    const set = ids.get(m[1]) ?? new Set<string>();
    set.add(n.id);
    ids.set(m[1], set);
  }
  const idx: LibraryIndex = { stamp, at: Date.now(), ids, seeds: new Map() };
  if (libraryIndexCache.size >= INDEX_MAX) libraryIndexCache.delete(libraryIndexCache.keys().next().value!);
  libraryIndexCache.set(key, idx);
  return idx;
}

async function loadLibrary(libraryNestId: string, seedId: string, userId: string): Promise<LoadedSeed | null> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(seedId)) return null;
  if (!(await libraryReadable(libraryNestId, userId))) return null;
  const idx = await libraryIndex(libraryNestId, userId);
  const cached = idx.seeds.get(seedId);
  if (cached instanceof Error) throw cached;
  if (cached) return cached;
  const readable = idx.ids.get(seedId);
  if (!readable?.has(`nodes/seeds/${seedId}/seed`)) return null;
  // The manifest first, then only the nodes it lists (L7).
  const m = await approvedNode(libraryNestId, `nodes/seeds/${seedId}/seed`);
  if (!m) return null;
  try {
    const manifest = parseManifest(m.body);
    if (manifest.id !== seedId) throw new SeedInvalidError(`the manifest's id "${manifest.id}" doesn't match its folder "${seedId}"`);
    const contents = new Map<string, SeedNodeContent>();
    for (const n of manifest.nodes) {
      if (!readable.has(`nodes/${n.id}`)) continue;
      const c = await approvedNode(libraryNestId, `nodes/${n.id}`);
      if (c) contents.set(n.id, c);
    }
    assertSeedSize(m.body, manifest, contents);
    const seed: LoadedSeed = { manifest, manifestText: m.body, contents, source: "library", libraryNestId };
    idx.seeds.set(seedId, seed);
    return seed;
  } catch (err) {
    if (err instanceof SeedInvalidError) idx.seeds.set(seedId, err);
    throw err;
  }
}

/** Load a seed for this caller. 404 when absent or unreadable, 422 when invalid. */
export async function loadSeed(input: { seedId: string; libraryNestId?: string | null; userId: string }): Promise<LoadedSeed> {
  try {
    const seed = input.libraryNestId ? await loadLibrary(input.libraryNestId, input.seedId, input.userId) : loadBundled(input.seedId);
    if (!seed) throw new NotFoundError(SEED_NOT_FOUND);
    return seed;
  } catch (err) {
    if (err instanceof SeedInvalidError) throw new UnprocessableError(`This seed can't be applied: ${err.message}.`);
    throw err;
  }
}

const refOf = (s: LoadedSeed): SeedRef => ({
  id: s.manifest.id,
  version: s.manifest.version,
  title: s.manifest.title,
  layers: [...s.manifest.layers],
  source: s.source,
  library_nest_id: s.libraryNestId,
});

/** Every seed this caller may apply: the bundled ones, plus governed libraries they can read. Invalid seeds are left out. */
export async function listSeedsFor(userId: string): Promise<SeedRef[]> {
  const out: SeedRef[] = [];
  for (const id of bundledSeedIds()) {
    try {
      const s = loadBundled(id);
      if (s) out.push(refOf(s));
    } catch {
      /* an invalid bundled seed is not offered */
    }
  }
  for (const lib of (await getSettings()).seed_library_nests) {
    if (!(await libraryReadable(lib, userId))) continue;
    const idx = await libraryIndex(lib, userId);
    for (const id of [...idx.ids.keys()].sort()) {
      try {
        const s = await loadLibrary(lib, id, userId);
        if (s) out.push(refOf(s));
      } catch {
        /* invalid: not offered */
      }
    }
  }
  return out;
}

// ─── listener ───────────────────────────────────────────────────────────────

interface ListenerSettings {
  propose_folders: string[];
  people_folders: string[];
  admin_folders: string[];
  domain_tags: string[];
  never_propose: string[];
  never_terms: string[];
  thesis_node_id: string | null;
}

function listenerSettingsOf(m: SeedManifest): ListenerSettings {
  const propose = [...m.listener.propose_folders];
  const thesis = m.thesis ? m.nodes.find((n) => n.id === m.thesis) : null;
  return {
    propose_folders: propose,
    people_folders: m.folders.filter((f) => f.purpose === ROLE.people && propose.includes(f.path)).map((f) => f.path),
    admin_folders: m.folders.filter((f) => f.admin_only).map((f) => f.path),
    domain_tags: [...m.listener.domain_tags],
    never_propose: [...m.listener.never_propose],
    never_terms: [...m.listener.never_terms],
    thesis_node_id: thesis && thesis.target !== CONTEXT_TARGET ? `nodes/${thesis.target}` : null,
  };
}

/** The union of every seed applied to a nest (in apply order), or null when none. */
async function nestListenerSettings(nestId: string): Promise<ListenerSettings | null> {
  const rows = (await getDb().all("SELECT listener_json FROM surface_seed_applications WHERE nest_id = ? ORDER BY applied_at, seed_id", [nestId])) as Array<{
    listener_json: string;
  }>;
  if (!rows.length) return null;
  const out: ListenerSettings = { propose_folders: [], people_folders: [], admin_folders: [], domain_tags: [], never_propose: [], never_terms: [], thesis_node_id: null };
  for (const r of rows) {
    let l: Partial<ListenerSettings> = {};
    try {
      l = JSON.parse(r.listener_json);
    } catch {
      continue;
    }
    for (const k of ["propose_folders", "people_folders", "admin_folders", "domain_tags", "never_propose", "never_terms"] as const) {
      for (const v of Array.isArray(l[k]) ? (l[k] as string[]) : []) if (!out[k].includes(v)) out[k].push(v);
    }
    if (!out.thesis_node_id && typeof l.thesis_node_id === "string") out.thesis_node_id = l.thesis_node_id;
  }
  return out;
}

/** Configure one binding's listener from its nest's seeds. False when the nest has none. */
export async function configureListenerFromSeeds(bindingId: string): Promise<boolean> {
  const row = (await getDb().get("SELECT nest_id FROM surface_bindings WHERE id = ? AND status <> 'removed'", [bindingId])) as { nest_id: string } | undefined;
  if (!row) return false;
  const l = await nestListenerSettings(row.nest_id);
  if (!l || !(await listenerFor(bindingId))) return false;
  await setListenerFolders(bindingId, l.propose_folders, l.people_folders, {
    domainTags: l.domain_tags,
    neverPropose: l.never_propose,
    neverTerms: l.never_terms,
    adminFolders: l.admin_folders,
    thesisNodeId: l.thesis_node_id,
  });
  return true;
}

async function configureNestListeners(nestId: string): Promise<number> {
  const rows = (await getDb().all("SELECT id FROM surface_bindings WHERE nest_id = ? AND status <> 'removed' AND listener_agent_node_id IS NOT NULL ORDER BY created_at", [
    nestId,
  ])) as Array<{ id: string }>;
  let n = 0;
  for (const r of rows) {
    try {
      if (await configureListenerFromSeeds(r.id)) n++;
    } catch {
      /* one bad listener doesn't stop the others */
    }
  }
  return n;
}

// ─── apply ──────────────────────────────────────────────────────────────────

async function claim(nestId: string): Promise<string> {
  const token = randomUUID();
  const now = Date.now();
  const r = await getDb().run(
    `INSERT INTO surface_seed_claims (nest_id, token, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (nest_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at WHERE surface_seed_claims.expires_at < ?`,
    [nestId, token, new Date(now + CLAIM_MS).toISOString(), new Date(now).toISOString()],
  );
  if (r.changes === 0) throw new ConflictError("A seed is already being applied to this nest. Try again in a moment.");
  return token;
}
/** Heartbeat (S7-R2 L2): extend our claim; false when it was lost. */
async function renew(nestId: string, token: string): Promise<boolean> {
  const r = await getDb().run("UPDATE surface_seed_claims SET expires_at = ? WHERE nest_id = ? AND token = ?", [new Date(Date.now() + CLAIM_MS).toISOString(), nestId, token]);
  return r.changes > 0;
}
async function release(nestId: string, token: string): Promise<void> {
  await getDb()
    .run("DELETE FROM surface_seed_claims WHERE nest_id = ? AND token = ?", [nestId, token])
    .catch(() => undefined);
}

interface ItemRecord {
  seed_hash: string;
  seed_origin: string;
  item_key: string | null;
}
async function recorded(nestId: string, kind: ApplyItem["kind"], target: string): Promise<ItemRecord | null> {
  return ((await getDb().get("SELECT seed_hash, seed_origin, item_key FROM surface_seed_items WHERE nest_id = ? AND kind = ? AND target = ?", [nestId, kind, target])) ??
    null) as ItemRecord | null;
}
const versionOf = (origin: string | null | undefined) => {
  const v = Number(String(origin ?? "").split("@").pop());
  return Number.isFinite(v) ? v : 0;
};
async function record(nestId: string, kind: ApplyItem["kind"], target: string, seedId: string, origin: string, hash: string, itemKey: string | null): Promise<void> {
  const now = iso();
  await getDb().run(
    `INSERT INTO surface_seed_items (nest_id, kind, target, seed_id, item_key, seed_origin, seed_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (nest_id, kind, target) DO UPDATE SET seed_id = excluded.seed_id, item_key = excluded.item_key, seed_origin = excluded.seed_origin,
       seed_hash = excluded.seed_hash, updated_at = excluded.updated_at`,
    [nestId, kind, target, seedId, itemKey, origin, hash, now, now],
  );
}

async function currentBody(nestId: string, id: string): Promise<string | null> {
  try {
    const { storage } = await engineCache.get(nestId);
    return String((await storage.readDocument(id)).body ?? "");
  } catch {
    return null;
  }
}

async function userEmail(userId: string): Promise<string> {
  const u = (await getDb().get("SELECT email FROM users WHERE id = ?", [userId])) as { email?: string } | undefined;
  if (!u?.email) throw new ForbiddenError("Only an owner or admin of this nest can apply a seed.");
  return u.email;
}

export interface ApplyInput {
  nestId: string;
  seedId: string;
  libraryNestId?: string | null;
  upgrade?: boolean;
  dryRun?: boolean;
  actorUserId: string;
  /**
   * The caller's credential (S7-R2 M1): an API key id, and whether the
   * surface is an agent surface (MCP, whatever it authenticated with). A
   * server-side apply (the DM default seed, as the owner) passes none.
   */
  credential?: { keyId: string | null; agentSurface: boolean };
}

/** Apply a seed to a nest (REST and MCP both call this; the result is the same). */
export async function applySeed(input: ApplyInput): Promise<ApplyResult> {
  if (!(await getDb().get("SELECT 1 AS x FROM nests WHERE id = ?", [input.nestId]))) throw new NotFoundError("Nest not found");
  if (!(await canAdministerNest(input.nestId, input.actorUserId))) throw new ForbiddenError("Only an owner or admin of this nest can apply a seed.");
  const email = await userEmail(input.actorUserId);
  // Load and validate everything BEFORE any write (all-or-nothing).
  const seed = await loadSeed({ seedId: input.seedId, libraryNestId: input.libraryNestId ?? null, userId: input.actorUserId });
  if (input.dryRun) return planOnly(input, seed);
  // The push-confirmation gate (M1): key and agent writes on a gated nest
  // need an allowlisted credential — a seed is too many writes to hold.
  const cred = input.credential;
  if (cred && (cred.keyId || cred.agentSurface) && (await nestRequiresPushConfirmation(input.nestId)) && !(await isPushAllowlisted(input.nestId, input.actorUserId, cred.keyId))) {
    throw new ForbiddenError(GATED_REFUSAL);
  }
  const token = await claim(input.nestId);
  try {
    return await applyClaimed(input, seed, email, token);
  } finally {
    await release(input.nestId, token);
  }
}

/** What one item would do, decided from the nest as it is now. */
interface Plan {
  kind: ApplyItem["kind"];
  target: string;
  decision: ReturnType<typeof decideItem>;
  rec: ItemRecord | null;
  want: string;
  /** node: the head version checked; definition: the row as checked; context: the revision seq checked. */
  head?: number;
  row?: { id: string; term: string; definition: string } | null;
  seq?: number;
  title?: string;
  body?: string;
}

async function plan(nestId: string, seed: LoadedSeed, upgrade: boolean): Promise<Plan[]> {
  const m = seed.manifest;
  const out: Plan[] = [];
  const common = (rec: ItemRecord | null) => ({ recordedVersion: rec ? versionOf(rec.seed_origin) : null, seedVersion: m.version, upgrade });
  for (const f of m.folders) {
    const rec = await recorded(nestId, "folder", f.path);
    const want = sha(f.path);
    const present = await vaultFolderExists(nestId, f.path.replace(/\/$/, ""));
    // A folder carries no text: present is fine whoever made it.
    const decision = present ? "unchanged" : decideItem({ present: false, recordedHash: rec?.seed_hash ?? null, currentHash: null, seedHash: want, ...common(rec) });
    out.push({ kind: "folder", target: f.path, decision, rec, want });
  }
  for (const d of m.definitions) {
    const want = definitionHash(d.term, d.definition);
    const rec = await recorded(nestId, "definition", d.term);
    const row = rec?.item_key
      ? (((await getDb().get("SELECT id, term, definition FROM definitions WHERE id = ? AND nest_id = ?", [rec.item_key, nestId])) as
          | { id: string; term: string; definition: string }
          | undefined) ?? null)
      : null;
    const sameTerm = !rec ? await getDb().get("SELECT id FROM definitions WHERE nest_id = ? AND LOWER(term) = LOWER(?)", [nestId, d.term]) : undefined;
    const decision = decideItem({
      present: !!row || !!sameTerm,
      recordedHash: rec ? rec.seed_hash : null,
      currentHash: row ? definitionHash(row.term, row.definition) : sameTerm ? "" : null,
      seedHash: want,
      ...common(rec),
    });
    out.push({ kind: "definition", target: d.term, decision, rec, want, row, title: d.term, body: d.definition });
  }
  for (const n of m.nodes) {
    const c = seed.contents.get(n.id)!;
    const want = seedHash(c.body);
    if (n.target === CONTEXT_TARGET) {
      const rec = await recorded(nestId, "context", CONTEXT_LABEL);
      const ins = await getInstructions(nestId);
      // Before anyone saved instructions the file is the nest's init template: absent.
      const decision = decideItem({
        present: rec ? true : !!ins.revision,
        recordedHash: rec?.seed_hash ?? null,
        currentHash: seedHash(ins.content),
        seedHash: want,
        ...common(rec),
      });
      out.push({ kind: "context", target: CONTEXT_LABEL, decision, rec, want, seq: ins.revision?.seq ?? 0, title: c.title, body: c.body });
      continue;
    }
    const id = `nodes/${n.target}`;
    const rec = await recorded(nestId, "node", id);
    const head = await getCurrentVersion(nestId, id).catch(() => 0);
    const body = await currentBody(nestId, id);
    const decision = decideItem({ present: body !== null, recordedHash: rec?.seed_hash ?? null, currentHash: body === null ? null : seedHash(body), seedHash: want, ...common(rec) });
    out.push({ kind: "node", target: id, decision, rec, want, head, title: c.title, body: c.body });
  }
  return out;
}

const plannedAction = (d: Plan["decision"]): ItemAction => (d === "updated" ? "update" : d);

async function planOnly(input: ApplyInput, seed: LoadedSeed): Promise<ApplyResult> {
  const m = seed.manifest;
  const plans = await plan(input.nestId, seed, !!input.upgrade);
  const l = listenerSettingsOf(m);
  return {
    status: "dry_run",
    nest_id: input.nestId,
    drafts: 0,
    seed: { id: m.id, version: m.version, source: seed.source, library_nest_id: seed.libraryNestId },
    items: plans.map((p) => ({
      kind: p.kind,
      target: p.target,
      action: plannedAction(p.decision),
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.body !== undefined ? { excerpt: excerpt(p.body) } : {}),
    })),
    listener: {
      propose_folders: l.propose_folders,
      people_folders: l.people_folders,
      admin_folders: l.admin_folders,
      domain_tags: l.domain_tags,
      never_propose: l.never_propose,
      bindings_configured: 0,
    },
    org_mirror: null,
  };
}

async function applyClaimed(input: ApplyInput, seed: LoadedSeed, email: string, token: string): Promise<ApplyResult> {
  const { manifest: m } = seed;
  const nestId = input.nestId;
  const upgrade = !!input.upgrade;
  const origin = seedOrigin(m);
  const prior = (await getDb().get("SELECT seed_version FROM surface_seed_applications WHERE nest_id = ? AND seed_id = ?", [nestId, m.id])) as
    | { seed_version: number }
    | undefined;
  const client = (hash: string) => ({ agent: "surfaces-seed", seed_origin: origin, seed_hash: hash });
  const items: ApplyItem[] = [];
  const plans = await plan(nestId, seed, upgrade);
  const contentOf = new Map(m.nodes.map((n) => [n.target === CONTEXT_TARGET ? CONTEXT_LABEL : `nodes/${n.target}`, seed.contents.get(n.id)!]));

  for (const p of plans) {
    let action: ItemAction = p.decision;
    try {
      if (p.decision === "create" || p.decision === "updated") {
        await seedTestHooks.beforeWrite?.(p.kind, p.target);
        action = await writeItem(nestId, m, origin, email, p, contentOf, client);
      } else if (p.decision === "unchanged" && p.rec && upgrade) {
        await record(nestId, p.kind, p.target, m.id, origin, p.rec.seed_hash, p.rec.item_key);
      } else if (p.decision === "unchanged" && !p.rec && p.kind === "folder") {
        await record(nestId, "folder", p.target, m.id, origin, p.want, null);
      }
    } catch (err) {
      // Idempotent and resumable (L1): report it, carry on; a re-run completes it.
      console.error(`[surfaces] seed item failed (${err instanceof AppError ? err.statusCode : "error"})`);
      action = "failed";
    }
    // On a governed nest the nest's rules may turn the write into a draft for
    // review: say so, per item and in total (nothing is published around review).
    const draft = p.kind === "node" && (action === "created" || action === "updated") && (await getApprovedVersion(nestId, p.target)) === null;
    items.push({ kind: p.kind, target: p.target, action, ...(draft ? { draft: true as const } : {}) });
  }
  await renew(nestId, token);

  // The application row, then every listener on the nest — even after a failed item.
  const listener = listenerSettingsOf(m);
  const anyUpdated = items.some((i) => i.action === "updated");
  const version = !prior ? m.version : upgrade ? Math.max(m.version, Number(prior.seed_version)) : Number(prior.seed_version);
  const now = iso();
  await getDb().run(
    `INSERT INTO surface_seed_applications (nest_id, seed_id, seed_version, source, library_nest_id, listener_json, applied_by, applied_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (nest_id, seed_id) DO UPDATE SET seed_version = excluded.seed_version, source = excluded.source, library_nest_id = excluded.library_nest_id,
       listener_json = excluded.listener_json, updated_at = excluded.updated_at`,
    [nestId, m.id, version, seed.source, seed.libraryNestId, JSON.stringify(listener), email, now, now],
  );
  const configured = await configureNestListeners(nestId);
  const merged = (await nestListenerSettings(nestId)) ?? listener;
  await renew(nestId, token);

  const orgMirror = m.layers.includes("org_mirror") ? await proposeOrgMirror(nestId, m, email, token) : null;

  let status: ApplyResult["status"];
  if (items.some((i) => i.action === "failed")) status = "partial";
  else if (!prior) status = "applied";
  else if (anyUpdated) status = "upgraded";
  else if (items.some((i) => i.action === "created")) status = "applied";
  else if (items.some((i) => i.action === "upgrade_available")) status = "upgrade_available";
  else status = "already_applied";

  return {
    status,
    nest_id: nestId,
    drafts: items.filter((i) => i.draft).length,
    seed: { id: m.id, version: m.version, source: seed.source, library_nest_id: seed.libraryNestId },
    items,
    listener: {
      propose_folders: merged.propose_folders,
      people_folders: merged.people_folders,
      admin_folders: merged.admin_folders,
      domain_tags: merged.domain_tags,
      never_propose: merged.never_propose,
      bindings_configured: configured,
    },
    org_mirror: orgMirror,
  };
}

/**
 * One create or update. Every update is a compare-and-set against what plan()
 * checked (L2): a node's head version, a definition's row, CONTEXT.md's
 * revision. A change in between is a human edit and is kept.
 */
async function writeItem(
  nestId: string,
  m: SeedManifest,
  origin: string,
  email: string,
  p: Plan,
  contentOf: Map<string, SeedNodeContent>,
  client: (hash: string) => Record<string, string>,
): Promise<ItemAction> {
  if (p.kind === "folder") {
    await createEmptyFolder(nestId, p.target.replace(/\/$/, ""));
    await record(nestId, "folder", p.target, m.id, origin, p.want, null);
    return "created";
  }
  if (p.kind === "definition") {
    const d = m.definitions.find((x) => x.term === p.target)!;
    if (p.decision === "create") {
      const id = randomUUID();
      const now = iso();
      try {
        await getDb().run(
          "INSERT INTO definitions (id, nest_id, term, definition, linked_tag, defined_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
          [id, nestId, d.term, d.definition, email, now, now],
        );
      } catch {
        return "kept_human_edit"; // a person defined that term meanwhile
      }
      await record(nestId, "definition", d.term, m.id, origin, p.want, id);
      return "created";
    }
    const row = p.row!;
    const r = await getDb().run("UPDATE definitions SET term = ?, definition = ?, defined_by = ?, updated_at = ? WHERE id = ? AND nest_id = ? AND term = ? AND definition = ?", [
      d.term,
      d.definition,
      email,
      iso(),
      row.id,
      nestId,
      row.term,
      row.definition,
    ]);
    if (r.changes === 0) return "kept_human_edit";
    await record(nestId, "definition", d.term, m.id, origin, p.want, row.id);
    return "updated";
  }
  const c = contentOf.get(p.target)!;
  if (p.kind === "context") {
    try {
      await writeInstructions(nestId, c.body, { authorEmail: email, note: `Seed ${origin}`, source: "api", baseSeq: p.seq ?? 0 });
    } catch (err) {
      if (err instanceof ConflictError) return "kept_human_edit";
      throw err;
    }
    const now = await getInstructions(nestId);
    await record(nestId, "context", CONTEXT_LABEL, m.id, origin, seedHash(now.content), null);
    return p.decision === "create" ? "created" : "updated";
  }
  if (seedTestHooks.failNode === p.target) throw new Error("injected seed failure");
  try {
    if (p.decision === "create") await createNode(nestId, { id: p.target, title: c.title, content: c.body, client: client(p.want) }, email);
    else await updateNode(nestId, p.target, { content: c.body, title: c.title, client: client(p.want) }, email, { expectHead: p.head });
  } catch (err) {
    if (err instanceof ConflictError) return "kept_human_edit"; // made or changed by a person meanwhile
    throw err;
  }
  await record(nestId, "node", p.target, m.id, origin, seedHash((await currentBody(nestId, p.target)) ?? c.body), null);
  return p.decision === "create" ? "created" : "updated";
}

// ─── org mirror (AC-SEED-07) ────────────────────────────────────────────────

/** A display name only: never an email, never empty. */
function cleanName(n: unknown): string | null {
  if (typeof n !== "string") return null;
  const s = n.replace(/[\r\n<>[\]|*_`#]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!s || s.includes("@") || !/[\p{L}\p{N}]/u.test(s)) return null;
  return s;
}
/** A channel group: the name's prefix before the first separator ("proj-acme" → "proj"). */
export function channelGroup(name: string): string {
  const n = name.replace(/^#/, "").toLowerCase();
  const head = n.split(/[-_.]/)[0];
  return head || n;
}

async function proposeOne(nestId: string, kind: "person" | "area", subject: string, folder: string, title: string, body: string, email: string, installId: string): Promise<boolean> {
  // Claim first (compare-and-set): a subject is proposed at most once.
  const r = await getDb().run(
    `INSERT INTO surface_seed_mirror (nest_id, kind, subject_key, install_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (nest_id, kind, subject_key) DO NOTHING`,
    [nestId, kind, subject, installId, iso()],
  );
  if (r.changes === 0) return false;
  try {
    const created = await createNode(nestId, { title, content: body, folder: folder.replace(/\/$/, "") }, email, {
      alwaysDraft: true,
      creatorReviews: false,
      notifyMentions: false,
    });
    const review = await submitForReview({ nestId, nodeId: created.node.id, version: created.version, requestedBy: email, note: "Proposed by a seed's org mirror" });
    await getDb().run("UPDATE surface_seed_mirror SET node_id = ?, review_id = ? WHERE nest_id = ? AND kind = ? AND subject_key = ?", [
      created.node.id,
      review.id,
      nestId,
      kind,
      subject,
    ]);
    return true;
  } catch (err) {
    // A document of that name already exists (or the write was refused): keep
    // the claim so the subject isn't retried on every apply. Counts only.
    console.error(`[surfaces] org-mirror proposal skipped (${err instanceof AppError ? err.statusCode : "error"})`);
    return false;
  }
}

async function proposeOrgMirror(nestId: string, m: SeedManifest, email: string, token: string): Promise<ApplyResult["org_mirror"]> {
  if (await sealedNest(nestId)) return { people: 0, areas: 0, skipped: "sealed" };
  const peopleFolder = m.folders.find((f) => f.purpose === ROLE.people)?.path ?? null;
  const areaFolder = m.folders.find((f) => f.purpose === ROLE.areas)?.path ?? null;
  // Only conversations the guard already admitted to THIS nest (readers ⊆ members).
  const bindings = (await getDb().all(
    `SELECT id, install_id, conversation_id, conversation_name FROM surface_bindings
      WHERE nest_id = ? AND status = 'active' AND capture_ok = 1 AND conversation_kind <> 'dm' ORDER BY created_at`,
    [nestId],
  )) as Array<{ id: string; install_id: string; conversation_id: string; conversation_name: string | null }>;
  const people = new Map<string, { name: string; installId: string; group: string | null }>();
  const groups = new Map<string, { channels: Set<string>; installId: string }>();
  for (const b of bindings) {
    if (!(await renew(nestId, token))) return { people: 0, areas: 0, skipped: "lock_lost" };
    const install = await getInstall(b.install_id);
    if (!install || install.status !== "active") continue;
    const name = b.conversation_name ? cleanName(b.conversation_name.replace(/^#/, "")) : null;
    const group = name ? channelGroup(name) : null;
    if (group && name) {
      const g = groups.get(group) ?? { channels: new Set<string>(), installId: install.id };
      g.channels.add(name);
      groups.set(group, g);
    }
    if (!peopleFolder) continue;
    const members = await safeMembers(getConnector(install.surface), installRef(install), b.conversation_id);
    if (!members.known) continue; // fail closed: an unknown room mirrors nobody
    for (const mem of members.members) {
      if (mem.is_bot || mem.is_external) continue;
      const link = (await getDb().get(
        "SELECT community_user_id FROM surface_identity_links WHERE install_id = ? AND surface_user_id = ? AND status = 'active'",
        [install.id, mem.surface_user_id],
      )) as { community_user_id: string } | undefined;
      if (!link || people.has(link.community_user_id)) continue;
      const profile = await getProfile(install.id, mem.surface_user_id).catch(() => null);
      const user = (await getDb().get("SELECT name FROM users WHERE id = ?", [link.community_user_id])) as { name?: string | null } | undefined;
      const display = cleanName(profile?.display_name) ?? cleanName(user?.name);
      if (display) people.set(link.community_user_id, { name: display, installId: install.id, group });
    }
  }
  let nPeople = 0;
  let nAreas = 0;
  const subjects: Array<() => Promise<boolean>> = [];
  for (const [uid, p] of people) {
    const body = `Name: ${p.name}${p.group ? `\nTeam: ${p.group}` : ""}\n`;
    subjects.push(async () => (await proposeOne(nestId, "person", uid, peopleFolder!, p.name, body, email, p.installId)) && !!++nPeople);
  }
  if (areaFolder) {
    for (const [g, v] of groups) {
      const body = `Area for the ${g} conversations.\n\nConversations: ${[...v.channels].sort().map((c) => `#${c}`).join(", ")}\n`;
      subjects.push(async () => (await proposeOne(nestId, "area", g, areaFolder, g, body, email, v.installId)) && !!++nAreas);
    }
  }
  for (const run of subjects) {
    // The heartbeat: renew before each subject; stop if another apply took over.
    if (!(await renew(nestId, token))) return { people: nPeople, areas: nAreas, skipped: "lock_lost" };
    await seedTestHooks.onMirrorSubject?.();
    await run();
  }
  return { people: nPeople, areas: nAreas, skipped: null };
}

// ─── status, preview, default seed ──────────────────────────────────────────

export interface SeedStatus {
  nest_id: string;
  no_seed: boolean;
  applied: Array<{ seed_id: string; version: number; source: string; library_nest_id: string | null }>;
}

export async function seedStatus(nestId: string, actorUserId: string): Promise<SeedStatus> {
  if (!(await canAdministerNest(nestId, actorUserId))) throw new ForbiddenError("Only an owner or admin of this nest can see its seeds.");
  const rows = (await getDb().all(
    "SELECT seed_id, seed_version, source, library_nest_id FROM surface_seed_applications WHERE nest_id = ? ORDER BY applied_at, seed_id",
    [nestId],
  )) as Array<{ seed_id: string; seed_version: number; source: string; library_nest_id: string | null }>;
  return {
    nest_id: nestId,
    no_seed: rows.length === 0,
    applied: rows.map((r) => ({ seed_id: r.seed_id, version: Number(r.seed_version), source: r.source, library_nest_id: r.library_nest_id ?? null })),
  };
}

/** The seeds a nest admin may apply to this nest. */
export async function listSeedsForNest(nestId: string, actorUserId: string): Promise<SeedRef[]> {
  if (!(await canAdministerNest(nestId, actorUserId))) throw new ForbiddenError("Only an owner or admin of this nest can apply seeds to it.");
  return listSeedsFor(actorUserId);
}

/** For the binding preview (AC-SEED-09): does the nest have a seed, and what could the caller apply? */
export async function seedPreview(nestId: string, actorUserId: string): Promise<{ no_seed: boolean; seeds: SeedRef[] }> {
  const has = await getDb().get("SELECT 1 AS x FROM surface_seed_applications WHERE nest_id = ?", [nestId]);
  return { no_seed: !has, seeds: has ? [] : await listSeedsFor(actorUserId).catch(() => []) };
}

export const DEFAULT_SEED_FAILED_TEXT =
  "Nest couldn't set up the folders in your private nest, so it can't file what you ask it to remember yet. A server administrator can check the default seed in Surfaces settings.";

/**
 * A DM personal nest gets `surfaces.default_seed`, applied as its OWNER
 * (sealed nests refuse server admins; the owner holds `owner`). Once: a nest
 * that already has a seed is left alone. Never throws — a failed seed leaves
 * the DM unseeded (its windows end `no_target_folder`), backs off for a day,
 * and tells the owner once (L7). A `partial` result counts as a failure and is
 * retried on the same schedule (re-applying is idempotent). Logs counts only.
 */
export async function applyDefaultSeed(nestId: string, ownerUserId: string): Promise<ApplyResult | null> {
  try {
    const failure = (await getDb().get("SELECT failed_at FROM surface_seed_default_failures WHERE nest_id = ?", [nestId])) as { failed_at: string } | undefined;
    // Applied and complete: done. A `partial` one (a failure row) is retried (S7-R3 INFO).
    if (!failure && (await getDb().get("SELECT 1 AS x FROM surface_seed_applications WHERE nest_id = ?", [nestId]))) return null;
    const ref = (await getSettings()).default_seed;
    if (!ref) return null;
    if (failure && failure.failed_at > new Date(Date.now() - DEFAULT_SEED_BACKOFF_MS).toISOString()) return null;
    seedTestHooks.defaultSeedAttempts++;
    const i = ref.indexOf(":");
    const libraryNestId = i > 0 ? ref.slice(0, i) : null;
    const seedId = i > 0 ? ref.slice(i + 1) : ref;
    const out = await applySeed({ nestId, seedId, libraryNestId, actorUserId: ownerUserId });
    // A partial seed is a failure for the backoff and the owner's notice.
    if (out.status === "partial") await defaultSeedFailed(nestId, ownerUserId);
    else await getDb().run("DELETE FROM surface_seed_default_failures WHERE nest_id = ?", [nestId]);
    return out;
  } catch (err) {
    // Another apply holds this nest's claim (two first DMs at once): that one
    // is doing the work — in progress, not a failure (no row, no notice).
    if (err instanceof ConflictError) return null;
    console.error(`[surfaces] default seed not applied (${err instanceof AppError ? err.statusCode : "error"})`);
    await defaultSeedFailed(nestId, ownerUserId).catch(() => undefined);
    return null;
  }
}

async function defaultSeedFailed(nestId: string, ownerUserId: string): Promise<void> {
  const now = iso();
  await getDb().run(
    `INSERT INTO surface_seed_default_failures (nest_id, failed_at, attempts, notified) VALUES (?, ?, 1, 0)
     ON CONFLICT (nest_id) DO UPDATE SET failed_at = excluded.failed_at, attempts = surface_seed_default_failures.attempts + 1`,
    [nestId, now],
  );
  // Tell the owner once (compare-and-set on notified).
  const r = await getDb().run("UPDATE surface_seed_default_failures SET notified = 1 WHERE nest_id = ? AND notified = 0", [nestId]);
  if (r.changes === 0) return;
  await recordNotice({
    kind: "default_seed_failed",
    audience: "user",
    recipientUserId: ownerUserId,
    nestId,
    detail: { attempts: 1 },
    subject: "Nest couldn't set up your private nest",
    text: DEFAULT_SEED_FAILED_TEXT,
  });
}
