import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { nowExpr } from "../db/sql.js";
import { config } from "../config.js";

/**
 * DB-backed list of official community site connections trusted for one-click
 * SSO auto-login (GET /auth/sso). Replaces the single OFFICIAL_COMMUNITY_SSO_
 * SECRET / PUBLIC_BASE_URL env-var pair with a list an admin manages from
 * Server Settings, so more than one official site can hand a ticket to this
 * server. The legacy env-var pair still works as an implicit extra entry
 * (see ssoCandidates) so existing single-site deployments are unaffected.
 */

export interface CommunitySite {
  id: string;
  name: string;
  url: string;
  secret: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

type SiteRow = {
  id: string;
  name: string;
  url: string;
  secret: string;
  is_active: number | boolean;
  created_at: string;
  updated_at: string;
};

function rowToSite(row: SiteRow): CommunitySite {
  return { ...row, is_active: !!row.is_active };
}

const SELECT_COLUMNS =
  "id, name, url, secret, is_active, created_at, updated_at";

// In-memory cache of ACTIVE sites, kept synchronous for the SSO hot path
// (mirrors the grantedSuperAdmins cache in governance/access-service.ts).
// Refreshed at boot and after every admin write.
let activeSitesCache: CommunitySite[] = [];

export async function loadActiveCommunitySites(): Promise<void> {
  const rows = (await getDb().all(
    `SELECT ${SELECT_COLUMNS} FROM community_sites WHERE is_active = 1 ORDER BY name`,
  )) as SiteRow[];
  activeSitesCache = rows.map(rowToSite);
}

/** Synchronous read of the cached active sites. */
export function getActiveCommunitySites(): CommunitySite[] {
  return activeSitesCache;
}

/** All configured sites (active and inactive), for the admin list view. */
export async function listCommunitySites(): Promise<CommunitySite[]> {
  const rows = (await getDb().all(
    `SELECT ${SELECT_COLUMNS} FROM community_sites ORDER BY name`,
  )) as SiteRow[];
  return rows.map(rowToSite);
}

export async function getCommunitySite(
  id: string,
): Promise<CommunitySite | null> {
  const row = (await getDb().get(
    `SELECT ${SELECT_COLUMNS} FROM community_sites WHERE id = ?`,
    [id],
  )) as SiteRow | undefined;
  return row ? rowToSite(row) : null;
}

export async function createCommunitySite(input: {
  name: string;
  url: string;
  secret: string;
  is_active: boolean;
}): Promise<CommunitySite> {
  const id = uuid();
  await getDb().run(
    `INSERT INTO community_sites (id, name, url, secret, is_active) VALUES (?, ?, ?, ?, ?)`,
    [id, input.name, input.url, input.secret, input.is_active ? 1 : 0],
  );
  const site = await getCommunitySite(id);
  if (!site) throw new Error("Failed to create community site");
  return site;
}

export async function updateCommunitySite(
  id: string,
  patch: Partial<{
    name: string;
    url: string;
    secret: string;
    is_active: boolean;
  }>,
): Promise<CommunitySite | null> {
  const existing = await getCommunitySite(id);
  if (!existing) return null;

  const next = {
    name: patch.name ?? existing.name,
    url: patch.url ?? existing.url,
    secret: patch.secret ?? existing.secret,
    is_active: patch.is_active ?? existing.is_active,
  };
  const db = getDb();
  await db.run(
    `UPDATE community_sites
        SET name = ?, url = ?, secret = ?, is_active = ?, updated_at = ${nowExpr(db)}
      WHERE id = ?`,
    [next.name, next.url, next.secret, next.is_active ? 1 : 0, id],
  );
  return getCommunitySite(id);
}

export async function deleteCommunitySite(id: string): Promise<boolean> {
  const result = await getDb().run("DELETE FROM community_sites WHERE id = ?", [
    id,
  ]);
  return result.changes > 0;
}

/** One secret/url pair GET /auth/sso will try a ticket against. */
export interface SsoCandidate {
  /** "legacy" for the env-var pair, otherwise the DB row's id. */
  id: string;
  /** Display label for logs — the site name, or "legacy" for the env pair. */
  label: string;
  secret: string;
  /**
   * The site's own URL, trailing slash stripped — a display/uniqueness field
   * for the admin list only. NOT checked against the ticket's `aud`: the
   * audience check in GET /auth/sso binds to config.PUBLIC_BASE_URL (this
   * deployment's own URL), the same for every candidate, so a ticket minted
   * for a different deployment can't be replayed here regardless of which
   * site's secret verified it.
   */
  url: string;
}

/**
 * The legacy single-site pair from OFFICIAL_COMMUNITY_SSO_SECRET /
 * PUBLIC_BASE_URL, kept as an implicit extra candidate so a deployment that
 * hasn't migrated to DB-configured sites yet keeps working unchanged.
 */
function legacyCandidate(): SsoCandidate | null {
  const secret = config.OFFICIAL_COMMUNITY_SSO_SECRET;
  if (!secret) return null;
  return { id: "legacy", label: "legacy", secret, url: config.PUBLIC_BASE_URL };
}

/**
 * Every secret/url pair GET /auth/sso should accept a ticket from right now:
 * every DB-configured active site plus the legacy env-var pair, if set.
 */
export function ssoCandidates(): SsoCandidate[] {
  const fromDb = getActiveCommunitySites().map((s) => ({
    id: s.id,
    label: s.name,
    secret: s.secret,
    url: s.url.replace(/\/$/, ""),
  }));
  const legacy = legacyCandidate();
  return legacy ? [...fromDb, legacy] : fromDb;
}
