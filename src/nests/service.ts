import { join } from "path";
import { rmSync, mkdirSync } from "fs";
import { v4 as uuid } from "uuid";
import { NestStorage } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { trackEvent } from "../telemetry/tracker.js";
import type { Nest } from "../shared/types.js";

function nestPath(nestId: string): string {
  return join(config.DATA_ROOT, "nests", nestId);
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Check if stewardship (draft-first + approval workflow) is enabled for a nest. */
export function isStewardshipEnabled(nestId: string): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT stewardship_enabled FROM nests WHERE id = ?")
    .get(nestId) as { stewardship_enabled: number } | undefined;
  return !!row?.stewardship_enabled;
}

/** Toggle stewardship on/off for a nest (admin-only). */
export function setStewardshipEnabled(nestId: string, enabled: boolean): void {
  const db = getDb();
  db.prepare("UPDATE nests SET stewardship_enabled = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    nestId,
  );
}

export async function createNest(
  userId: string,
  name: string,
  description?: string,
): Promise<Nest> {
  const id = uuid();
  const slug = toSlug(name);
  const db = getDb();

  db.prepare(
    "INSERT INTO nests (id, user_id, name, slug, description) VALUES (?, ?, ?, ?, ?)",
  ).run(id, userId, name, slug, description || null);

  const path = nestPath(id);
  mkdirSync(path, { recursive: true });
  const storage = new NestStorage(path);
  await storage.init(name);

  trackEvent("nest.create", { nestId: id, userId });

  return db.prepare("SELECT * FROM nests WHERE id = ?").get(id) as Nest;
}

const ANON_USER_ID = "00000000-0000-0000-0000-000000000000";

export function listNests(userId: string): Nest[] {
  const db = getDb();
  // Always include anonymous-owned nests as the ungoverned shared commons,
  // plus nests owned by the caller. De-dupe when caller IS the anonymous user.
  if (userId === ANON_USER_ID) {
    return db
      .prepare("SELECT * FROM nests WHERE user_id = ? ORDER BY created_at DESC")
      .all(ANON_USER_ID) as Nest[];
  }
  return db
    .prepare(
      "SELECT * FROM nests WHERE user_id = ? OR user_id = ? ORDER BY created_at DESC",
    )
    .all(userId, ANON_USER_ID) as Nest[];
}

export function isAnonymousNest(nest: Pick<Nest, "user_id">): boolean {
  return nest.user_id === ANON_USER_ID;
}

export function listSharedNests(userId: string): Nest[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT DISTINCT n.* FROM nests n
       JOIN nest_collaborators nc ON nc.nest_id = n.id
       WHERE n.user_id != ? AND nc.user_id = ?
       ORDER BY n.created_at DESC`,
    )
    .all(userId, userId) as Nest[];
}

export function getNest(nestId: string): Nest | null {
  const db = getDb();
  return (
    (db.prepare("SELECT * FROM nests WHERE id = ?").get(nestId) as Nest) ||
    null
  );
}

export async function deleteNest(nestId: string): Promise<void> {
  const db = getDb();

  db.prepare("DELETE FROM api_keys WHERE nest_id = ?").run(nestId);
  db.prepare("DELETE FROM nests WHERE id = ?").run(nestId);

  const path = nestPath(nestId);
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Directory may not exist
  }

  trackEvent("nest.delete", { nestId });
}
