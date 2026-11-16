/**
 * Sealed personal nests (Misha, 2026-11-01, "Build sealed nests now").
 *
 * Every personal (DM) nest Surfaces creates is sealed: its owner keeps full
 * access, and server admins (license admin, superadmins) lose the admin they
 * hold on every other nest — no content read and no writes of any kind. They
 * keep: knowing it exists (owner, size, created date — no titles), deleting
 * it, and quota. Non-sealed nests are untouched.
 *
 * Dependency-light (only the DB client) because the core access resolver and
 * the stewardship service import it.
 *
 * Fails CLOSED (re-review N1): only a database without the Surfaces tables
 * means "not sealed". Any other error reads as sealed with an unknown owner,
 * which only ever narrows a server admin's access for that call.
 */
import { getDb } from "../db/client.js";

export interface SealedNest {
  ownerId: string;
  ownerEmail: string;
}

const UNKNOWN: SealedNest = { ownerId: "\u0000unknown", ownerEmail: "\u0000unknown" };

/** Tests only. */
export const sealedTestHooks: { fail?: boolean } = {};

export async function sealedNest(nestId: string): Promise<SealedNest | null> {
  try {
    if (sealedTestHooks.fail) throw new Error("injected sealed lookup failure");
    const r = (await getDb().get(
      `SELECT p.community_user_id AS owner_id, u.email AS owner_email FROM surface_personal_nests p
         LEFT JOIN users u ON u.id = p.community_user_id
        WHERE p.nest_id = ? AND p.sealed = 1 LIMIT 1`,
      [nestId],
    )) as { owner_id: string; owner_email: string | null } | undefined;
    if (!r) return null;
    return { ownerId: r.owner_id, ownerEmail: r.owner_email ?? UNKNOWN.ownerEmail };
  } catch (err) {
    if (missingSealedTable(err instanceof Error ? err.message : String(err))) return null;
    console.error("[surfaces] sealed-nest lookup failed; failing closed (1)");
    return UNKNOWN;
  }
}

/**
 * Re-review R3-L2: only a missing TABLE (a database without Surfaces) means
 * "not sealed". A missing COLUMN (an earlier 081) or any other error fails
 * closed.
 */
export function missingSealedTable(message: string): boolean {
  return /no such table:\s*surface_personal_nests\b|relation "surface_personal_nests" does not exist/i.test(message);
}

/** The guarded add for a database that ran an earlier 081 without `sealed`. */
export async function ensureSealedColumn(): Promise<void> {
  const db = getDb();
  if (db.dialect === "postgres") {
    await db.exec("ALTER TABLE surface_personal_nests ADD COLUMN IF NOT EXISTS sealed INTEGER NOT NULL DEFAULT 1");
    return;
  }
  const cols = (await db.all("PRAGMA table_info(surface_personal_nests)", [])) as Array<{ name: string }>;
  if (cols.length && !cols.some((c) => c.name === "sealed")) {
    await db.exec("ALTER TABLE surface_personal_nests ADD COLUMN sealed INTEGER NOT NULL DEFAULT 1");
  }
}

/** Does this user own a sealed personal nest? (Fails closed: an error says yes.) */
export async function ownsSealedNest(userId: string): Promise<boolean> {
  try {
    return !!(await getDb().get("SELECT 1 AS x FROM surface_personal_nests WHERE community_user_id = ? AND sealed = 1 LIMIT 1", [userId]));
  } catch (err) {
    return !missingSealedTable(err instanceof Error ? err.message : String(err));
  }
}

/** The nest id a notification link (`?nest=<id>`) points at, if any. */
export function nestIdFromLink(link: string | null | undefined): string | null {
  if (!link) return null;
  const m = /[?&]nest=([A-Za-z0-9-]+)/.exec(link);
  return m ? m[1] : null;
}

/** Is this nest sealed against this (non-owner) user? */
export async function sealedAgainstUser(nestId: string, userId: string): Promise<boolean> {
  const s = await sealedNest(nestId);
  return !!s && s.ownerId !== userId;
}

export async function sealedAgainstEmail(nestId: string, email: string): Promise<boolean> {
  const s = await sealedNest(nestId);
  return !!s && s.ownerEmail.toLowerCase() !== email.toLowerCase();
}

/** Counts-only audit of a refused content access by a server admin. Never throws. */
export async function auditSealedRefusal(nestId: string, userId: string): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await getDb().run(
      `INSERT INTO surface_sealed_access_log (nest_id, user_id, day, refused, created_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (nest_id, user_id, day) DO UPDATE SET refused = surface_sealed_access_log.refused + 1`,
      [nestId, userId, day, new Date().toISOString()],
    );
  } catch {
    /* the audit never breaks the refusal */
  }
}

/** Does this server hold any sealed nest? (Fails closed: an error says yes.) */
export async function anySealedNest(): Promise<boolean> {
  try {
    return !!(await getDb().get("SELECT 1 AS x FROM surface_personal_nests WHERE sealed = 1 LIMIT 1", []));
  } catch (err) {
    return !missingSealedTable(err instanceof Error ? err.message : String(err));
  }
}
