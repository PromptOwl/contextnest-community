import { mkdirSync } from "fs";
import { v4 as uuid } from "uuid";
import { NestStorage } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { resolveNestPath } from "../shared/paths.js";
import { trackEvent } from "../telemetry/tracker.js";
import { isLicenseAdminUserId } from "../auth/license.js";
import { isServerAdminUserId } from "../shared/access.js";
import { ANON_USER_ID } from "../shared/constants.js";
import { ValidationError } from "../shared/errors.js";
import { normalizeTag } from "../governance/tag-index-service.js";
import { rm } from "fs/promises";
import type { Nest } from "../shared/types.js";

/**
 * On-disk storage root for a nest. Resolution lives in `shared/paths.ts`
 * (honours NEST_STORAGE_ROOT, default `<DATA_ROOT>/nests`); re-exported here
 * for backward compatibility with existing importers (e.g. `nodes/engine.ts`).
 */
export { resolveNestPath };

/**
 * True when the nest was imported from a folder. Imported nests use flat
 * discovery (markdown anywhere in the folder, not just nodes/) because an
 * existing user vault rarely matches the engine's structured layout.
 */
export async function isImportedNest(nestId: string): Promise<boolean> {
  const row = (await getDb().get(
    "SELECT is_imported FROM nests WHERE id = ?",
    [nestId],
  )) as { is_imported: number } | undefined;
  return !!row?.is_imported;
}

/**
 * Nest names are plain text. Tag-shaped markup is refused rather than stripped:
 * silently deleting it lost legitimate text ("Roadmap <2026> plan" was stored
 * as "Roadmap  plan") and collapsed distinct names onto one slug. Angle
 * brackets that aren't a tag are kept as typed — every surface that renders a
 * name into HTML escapes it (publish pages, email, Slack, React). That is now
 * load-bearing: a name reaches storage unescaped, so any NEW surface that
 * renders one (an export, a PDF, a webhook payload) must escape it there.
 */
/** A nest name is a card title and a list row; an unbounded one broke both
 *  layouts (CU-wdqcq018qx). The UI refuses the same length up front
 *  (ui/src/lib/nest-name.ts) so this is the guard for callers that skip it. */
export const MAX_NEST_NAME_LENGTH = 100;

function plainName(name: string, emptyMessage = "Name cannot be empty"): string {
  const typed = (name ?? "").trim();
  if (!typed) throw new ValidationError(emptyMessage);
  if (typed.length > MAX_NEST_NAME_LENGTH) {
    throw new ValidationError(
      `Nest names are capped at ${MAX_NEST_NAME_LENGTH} characters`,
    );
  }
  if (/<\/?[a-zA-Z][^>]*>/.test(typed)) {
    throw new ValidationError(
      "Nest names are plain text — remove the HTML tags.",
    );
  }
  return typed;
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Append " (N)" to `baseName` until both the resulting display name and the
 * derived slug are free for this user. The DB enforces UNIQUE(user_id, slug),
 * so importing a folder whose leaf name collides with an existing nest used
 * to error out — this helper produces "abc", "abc (1)", "abc (2)", ….
 */
/**
 * The one duplicate-name guard. UNIQUE(user_id, slug) would otherwise surface
 * as a raw constraint error — friendly enough on SQLite, a bare 500 wherever
 * the driver reports it differently. `exceptId` skips the nest being renamed.
 */
async function assertSlugFree(
  userId: string,
  slug: string,
  message: string,
  exceptId?: string,
): Promise<void> {
  const conflict = (await getDb().get(
    exceptId
      ? "SELECT id FROM nests WHERE user_id = ? AND slug = ? AND id != ? LIMIT 1"
      : "SELECT id FROM nests WHERE user_id = ? AND slug = ? LIMIT 1",
    exceptId ? [userId, slug, exceptId] : [userId, slug],
  )) as { id: string } | undefined;
  if (conflict) throw new ValidationError(message);
}

export async function uniqueNestName(
  userId: string,
  baseName: string,
): Promise<string> {
  const db = getDb();
  let candidate = baseName;
  let n = 0;
  // Bound the loop to keep a buggy DB / accidental rename storm from spinning
  // forever; 1000 collisions on the same name is already absurd.
  while (n < 1000) {
    const slug = toSlug(candidate);
    const hit = await db.get(
      "SELECT 1 FROM nests WHERE user_id = ? AND slug = ? LIMIT 1",
      [userId, slug],
    );
    if (!hit) return candidate;
    n++;
    candidate = `${baseName} (${n})`;
  }
  // Fallback: extreme collision count — let the caller still try; the DB
  // constraint will surface a clearer error than a silent infinite loop.
  return candidate;
}

/** Check if stewardship (draft-first + approval workflow) is enabled for a nest. */
export async function isStewardshipEnabled(nestId: string): Promise<boolean> {
  const db = getDb();
  const row = (await db.get(
    "SELECT stewardship_enabled FROM nests WHERE id = ?",
    [nestId],
  )) as { stewardship_enabled: number } | undefined;
  return !!row?.stewardship_enabled;
}

/** Toggle stewardship on/off for a nest (admin-only). */
export async function setStewardshipEnabled(
  nestId: string,
  enabled: boolean,
): Promise<void> {
  const db = getDb();
  await db.run("UPDATE nests SET stewardship_enabled = ? WHERE id = ?", [
    enabled ? 1 : 0,
    nestId,
  ]);
}


/**
 * Configure Public Docs Reader Mode for a nest (superadmin-only). Either field
 * may be updated independently; `enabled` toggles the read-only public view and
 * `homeNode` designates (or clears, with null) the landing/hub node.
 */
export async function setReaderMode(
  nestId: string,
  opts: { enabled?: boolean; homeNode?: string | null },
): Promise<void> {
  const db = getDb();
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (opts.enabled !== undefined) {
    sets.push("reader_mode = ?");
    params.push(opts.enabled ? 1 : 0);
  }
  if (opts.homeNode !== undefined) {
    sets.push("reader_home_node = ?");
    params.push(opts.homeNode ?? null);
  }
  if (sets.length === 0) return;
  params.push(nestId);
  await db.run(`UPDATE nests SET ${sets.join(", ")} WHERE id = ?`, params);
}

/** Whether the nest lets a submitter approve their own version (bypass SoD). */
export async function nestAllowsSelfApprove(
  nestId: string,
): Promise<boolean> {
  const db = getDb();
  const row = (await db.get(
    "SELECT allow_self_approve FROM nests WHERE id = ?",
    [nestId],
  )) as { allow_self_approve: number } | undefined;
  return !!row?.allow_self_approve;
}

/** Toggle self-approve bypass on/off for a nest (admin-only). */
export async function setAllowSelfApprove(
  nestId: string,
  allow: boolean,
): Promise<void> {
  const db = getDb();
  await db.run("UPDATE nests SET allow_self_approve = ? WHERE id = ?", [
    allow ? 1 : 0,
    nestId,
  ]);
}

/**
 * Whether an agent write (MCP context_create, POST /nodes, POST /publish) to
 * this nest must be confirmed in the web UI before it applies — the Push
 * Confirmation Gate. Superadmin-set
 * only; default off = today's immediate-apply behaviour. Mirrors
 * nestAllowsSelfApprove above.
 */
export async function nestRequiresPushConfirmation(
  nestId: string,
): Promise<boolean> {
  const db = getDb();
  const row = (await db.get(
    "SELECT require_push_confirmation FROM nests WHERE id = ?",
    [nestId],
  )) as { require_push_confirmation: number } | undefined;
  return !!row?.require_push_confirmation;
}

/** Toggle the Push Confirmation Gate for a nest (superadmin-only). */
export async function setRequirePushConfirmation(
  nestId: string,
  require: boolean,
): Promise<void> {
  const db = getDb();
  await db.run(
    "UPDATE nests SET require_push_confirmation = ? WHERE id = ?",
    [require ? 1 : 0, nestId],
  );
}

/**
 * Whether a governed nest reviews ONLY its prime documents. Off (the default)
 * keeps the original posture: every write lands as a draft unless the actor
 * holds a self-approve bypass. On, everything self-publishes except documents
 * that resolve as prime — those always go through the review cycle.
 */
export async function nestReviewsPrimeOnly(nestId: string): Promise<boolean> {
  const db = getDb();
  const row = (await db.get(
    "SELECT prime_only_review FROM nests WHERE id = ?",
    [nestId],
  )) as { prime_only_review: number } | undefined;
  return !!row?.prime_only_review;
}

/** Toggle the prime-only review posture for a nest (admin-only). */
export async function setPrimeOnlyReview(
  nestId: string,
  enabled: boolean,
): Promise<void> {
  const db = getDb();
  await db.run("UPDATE nests SET prime_only_review = ? WHERE id = ?", [
    enabled ? 1 : 0,
    nestId,
  ]);
}

/**
 * Tags that mark a document prime, normalized and deduped. Stored as a comma
 * list on the nest; an empty/blank value means "no tag marks a doc prime"
 * (document-level flags still apply).
 */
export async function nestPrimeTags(nestId: string): Promise<string[]> {
  const db = getDb();
  const row = (await db.get("SELECT prime_tags FROM nests WHERE id = ?", [
    nestId,
  ])) as { prime_tags: string | null } | undefined;
  return parsePrimeTags(row?.prime_tags);
}

/**
 * Replace the nest's prime tag set (admin-only).
 *
 * Round-tripping through a comma string is deliberate: a comma is the
 * separator, so it cannot be part of a tag. `normalizeTag` already keeps tags
 * to bare words, and a caller sending "a,b" as one entry means two tags.
 */
export async function setPrimeTags(
  nestId: string,
  tags: string[],
): Promise<void> {
  const db = getDb();
  await db.run("UPDATE nests SET prime_tags = ? WHERE id = ?", [
    parsePrimeTags(tags.join(",")).join(","),
    nestId,
  ]);
}

/** Comma list → normalized, deduped tag names (no leading `#`, lowercased). */
export function parsePrimeTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((t) => normalizeTag(t))
        .filter(Boolean),
    ),
  ];
}

/**
 * Disable stewardship and tear down the governance state tied to it:
 * steward assignments and any pending review requests.
 *
 * Collaborator access is NOT touched — sharing is independent of governance
 * (a nest can be shared with or without stewardship). Removing a share is a
 * separate, explicit action via the Share UI.
 *
 * Only pending review_requests are removed — approved/rejected/cancelled
 * rows are historical audit data and stay.
 */
export async function disableStewardshipAndWipeGovernance(
  nestId: string,
): Promise<{
  stewards: number;
  pendingReviews: number;
}> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const id = nestId;
    const stewards = (
      await tx.run("DELETE FROM stewards WHERE nest_id = ?", [id])
    ).changes;
    const pendingReviews = (
      await tx.run(
        "DELETE FROM review_requests WHERE nest_id = ? AND status = 'pending'",
        [id],
      )
    ).changes;
    await tx.run("UPDATE nests SET stewardship_enabled = 0 WHERE id = ?", [id]);
    return { stewards, pendingReviews };
  });
}

/**
 * Update the human-facing fields of a nest (name + description). The slug is
 * recomputed from the new name so collaborators see it in the URL-friendly
 * form too, and we reject the change if it would collide with another nest
 * the same user already owns (UNIQUE(user_id, slug) would throw anyway —
 * surfacing a clean error keeps the autosave UX sane).
 *
 * On-disk state is untouched. The folder stays at its `resolveNestPath(id)`
 * location (see shared/paths.ts — `<NEST_STORAGE_ROOT>/<id>`, default
 * `<DATA_ROOT>/nests/<id>`); renaming a nest never relocates its files.
 */
export async function renameNest(
  nestId: string,
  patch: { name?: string; description?: string | null },
): Promise<Nest> {
  const db = getDb();
  const existing = (await db.get("SELECT * FROM nests WHERE id = ?", [
    nestId,
  ])) as Nest | undefined;
  if (!existing) {
    throw new ValidationError("Nest not found");
  }

  const updates: string[] = [];
  const params: any[] = [];

  if (patch.name !== undefined) {
    const trimmed = plainName(patch.name);
    const slug = toSlug(trimmed);
    if (!slug) throw new ValidationError("Name must contain at least one alphanumeric character");
    await assertSlugFree(
      existing.user_id,
      slug,
      "Another nest already uses this name. Pick a different one.",
      nestId,
    );
    updates.push("name = ?", "slug = ?");
    params.push(trimmed, slug);
  }

  if (patch.description !== undefined) {
    updates.push("description = ?");
    params.push(patch.description || null);
  }

  if (updates.length === 0) {
    return existing;
  }

  params.push(nestId);
  await db.run(
    `UPDATE nests SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );

  return (await db.get("SELECT * FROM nests WHERE id = ?", [nestId])) as Nest;
}

export async function createNest(
  userId: string,
  name: string,
  description?: string,
): Promise<Nest> {
  const id = uuid();
  const db = getDb();

  const trimmed = plainName(name);
  const slug = toSlug(trimmed);
  if (!slug) {
    throw new ValidationError(
      "Name must contain at least one alphanumeric character",
    );
  }
  // Surface the duplicate BEFORE the INSERT would trip UNIQUE(user_id, slug) —
  // the raw constraint error otherwise bubbled up as a generic 500 with no
  // hint that the name was taken. Mirrors renameNest's conflict guard.
  await assertSlugFree(
    userId,
    slug,
    "You already have a nest with this name. Pick a different one.",
  );

  // Ungoverned (anon-owned) nests default to public so the shared commons
  // stays visible to everyone in both open and key modes. Admin can flip
  // an individual nest to private later via PATCH /nests/:id/visibility.
  const visibility = userId === ANON_USER_ID ? "public" : "private";

  await db.run(
    "INSERT INTO nests (id, user_id, name, slug, description, visibility) VALUES (?, ?, ?, ?, ?, ?)",
    [id, userId, trimmed, slug, description || null, visibility],
  );

  const path = resolveNestPath(id);
  mkdirSync(path, { recursive: true });
  const storage = new NestStorage(path);
  await storage.init(trimmed);

  trackEvent("nest.create", { nestId: id, userId });

  return (await db.get("SELECT * FROM nests WHERE id = ?", [id])) as Nest;
}

/**
 * Create the empty nest a browser folder import will be uploaded into.
 *
 * Only the row and the directory: the uploaded files are handed to the engine
 * (`stageImportedFiles`), which writes them into this nest's storage verbatim.
 * The server never browses its own filesystem, so import works whether or not
 * it is colocated with the user, and it arrives in chunks rather than one body.
 *
 * The nest is flagged is_imported=1 so it discovers its docs via the flat
 * layout (markdown anywhere, not just nodes/). Governance metadata is seeded on
 * import (registerImportedDocuments) and extended lazily on edit/review,
 * exactly like a default nest.
 *
 * A caller whose upload then fails should `deleteNest` this row — a half-filled
 * nest lists as real with silently missing documents.
 */
export async function importNest(userId: string, name: string): Promise<Nest> {
  const nm = plainName(name || "", "name is required");

  const db = getDb();
  const id = uuid();
  const slug = toSlug(nm);
  // Same guard as createNest: re-importing a folder under a name that is
  // already taken has to read as "pick another name", not as a server error.
  await assertSlugFree(
    userId,
    slug,
    "A nest with this name already exists. Pick a different name.",
  );
  const visibility = userId === ANON_USER_ID ? "public" : "private";

  mkdirSync(resolveNestPath(id), { recursive: true });
  await db.run(
    "INSERT INTO nests (id, user_id, name, slug, description, visibility, is_imported) VALUES (?, ?, ?, ?, ?, ?, 1)",
    [id, userId, nm, slug, null, visibility],
  );

  trackEvent("nest.import", { nestId: id, userId });

  return (await db.get("SELECT * FROM nests WHERE id = ?", [id])) as Nest;
}

/**
 * Pin a nest for one person. Pinning is a personal bookmark, not a change to
 * the nest — two people sharing one nest keep different pins — so there is no
 * permission tier beyond being able to see it (the route gate handles that).
 * Idempotent: pinning an already-pinned nest is a no-op, not a constraint error.
 */
export async function pinNest(userId: string, nestId: string): Promise<void> {
  const db = getDb();
  // No INSERT OR IGNORE / ON CONFLICT — the two dialects spell it differently.
  // The check is the fast path; the catch is what makes it correct. Two clicks
  // landing together both pass the SELECT, and the loser's INSERT trips the
  // (user_id, nest_id) primary key — which would surface as a 409 on SQLite and
  // a 500 on Postgres for an operation whose whole contract is idempotence. A
  // double-click is the likeliest way to reach this, so it is not theoretical.
  const existing = await db.get(
    "SELECT 1 FROM nest_pins WHERE user_id = ? AND nest_id = ?",
    [userId, nestId],
  );
  if (existing) return;
  try {
    await db.run(
      "INSERT INTO nest_pins (user_id, nest_id) VALUES (?, ?)",
      [userId, nestId],
    );
  } catch (err) {
    // Re-read rather than pattern-match the driver's error text: if the row is
    // there now, someone else's insert won and the caller's intent is satisfied.
    // Anything else (a real failure) still throws.
    const now = await db.get(
      "SELECT 1 FROM nest_pins WHERE user_id = ? AND nest_id = ?",
      [userId, nestId],
    );
    if (!now) throw err;
  }
}

/** Remove a pin. Idempotent — unpinning what isn't pinned is a no-op. */
export async function unpinNest(userId: string, nestId: string): Promise<void> {
  await getDb().run(
    "DELETE FROM nest_pins WHERE user_id = ? AND nest_id = ?",
    [userId, nestId],
  );
}

/**
 * Every nest this person has pinned, as a Set. ONE query for the whole
 * dashboard: the card annotation runs per nest, and asking per card would add a
 * round trip to each one for a boolean.
 */
export async function pinnedNestIds(userId: string): Promise<Set<string>> {
  const rows = (await getDb().all(
    "SELECT nest_id FROM nest_pins WHERE user_id = ?",
    [userId],
  )) as Array<{ nest_id: string }>;
  return new Set(rows.map((r) => r.nest_id));
}

/**
* Archived nests are absent from every listing unless one explicitly asks for
* them. Kept as SQL fragments rather than a post-filter so a nest that is put
* away stops costing a row, a discovery walk and a title map everywhere it used
* to appear — the work inbox, drafts, global search and the MCP index all read
* through these helpers.
*/
const LIVE_ONLY = "archived_at IS NULL";
const LIVE_ONLY_N = "n.archived_at IS NULL";

/**
* Owned nests. `archived: true` flips the list to ONLY archived rows — the
* dashboard's Archived tab. It is deliberately the only helper that can show
* them: archive, restore and delete are the owner's, so nobody else has an
* action to take on an archived nest, and surfacing it to a collaborator would
* be a card they can only look at.
*/
export async function listNests(
 userId: string,
 opts: { archived?: boolean } = {},
): Promise<Nest[]> {
  const db = getDb();
  const scope = opts.archived ? "archived_at IS NOT NULL" : LIVE_ONLY;
  // Own rows + (for admin/open) all anon-owned. Public discovery is
  // listPublicNests; route layer dedupes by id.
  if (userId === ANON_USER_ID) {
    return (await db.all(
      `SELECT * FROM nests WHERE user_id = ? AND ${scope} ORDER BY created_at DESC`,
      [ANON_USER_ID],
    )) as Nest[];
  }
  const includeAnon =
    config.AUTH_MODE === "open" || (await isLicenseAdminUserId(userId));
  if (!includeAnon) {
    return (await db.all(
      `SELECT * FROM nests WHERE user_id = ? AND ${scope} ORDER BY created_at DESC`,
      [userId],
    )) as Nest[];
  }
  return (await db.all(
    `SELECT * FROM nests WHERE (user_id = ? OR user_id = ?) AND ${scope}
      ORDER BY created_at DESC`,
    [userId, ANON_USER_ID],
  )) as Nest[];
}

/**
 * Put a nest away: hidden and read-only, nothing deleted. Idempotent.
 *
 * Both statements run in ONE transaction, for the reason deleteNest gives: the
 * flag and the queue cleanup have to land together. An editor's "please archive
 * this nest" is answered by the nest being archived, however that happened — the
 * owner may well have done it directly rather than through the queue — and a
 * request row that outlived the flag is stranded for good, since an archived
 * nest caps everyone at read and the honour route can never action it again.
 * Crashing between the two would produce exactly the state this cleanup exists
 * to prevent.
 */
export async function archiveNest(nestId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.run(
      "UPDATE nests SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
      [new Date().toISOString(), nestId],
    );
    await tx.run(
      `DELETE FROM deletion_requests
        WHERE nest_id = ? AND target_type = 'nest_archive' AND status = 'pending'`,
      [nestId],
    );
  });
}

/** Bring it back exactly as it was — same documents, versions, stewards. */
export async function restoreNest(nestId: string): Promise<void> {
  await getDb().run("UPDATE nests SET archived_at = NULL WHERE id = ?", [nestId]);
}

export function isAnonymousNest(nest: Pick<Nest, "user_id">): boolean {
  return nest.user_id === ANON_USER_ID;
}

/**
 * Nests reachable because the user is a member of a team shared onto them.
 * Read-only listing helper — access + role for every action still resolve
 * through resolveNestPermission/resolveUserRoles (which already fold in teams),
 * so this only makes those nests visible on the dashboard. Pure JS filtering so
 * it works identically on SQLite and Postgres (shared_teams/members are TEXT
 * JSON on both).
 */
async function nestsSharedViaTeams(userId: string): Promise<Nest[]> {
  const db = getDb();
  // Narrow in SQL first — this runs on every dashboard load, so it must never
  // pull every team (or every team-shared nest) in the deployment into memory.
  // The LIKE prefilter can't false-negative (a member id always appears
  // verbatim in the JSON); the JS pass below confirms real membership.
  const teams = (await db.all(
    "SELECT id, members FROM teams WHERE members LIKE ?",
    [`%${userId}%`],
  )) as Array<{ id: string; members: string }>;
  const myTeamIds = new Set<string>();
  for (const t of teams) {
    try {
      const members = JSON.parse(t.members || "[]");
      if (Array.isArray(members) && members.some((m: any) => m?.userId === userId)) {
        myTeamIds.add(t.id);
      }
    } catch {
      /* skip malformed roster */
    }
  }
  if (myTeamIds.size === 0) return [];
  const ids = [...myTeamIds];
  const candidates = (await db.all(
    `SELECT * FROM nests
       WHERE user_id != ?
         AND ${LIVE_ONLY}
         AND (${ids.map(() => "shared_teams LIKE ?").join(" OR ")})`,
    [userId, ...ids.map((id) => `%${id}%`)],
  )) as Array<Nest & { shared_teams?: string }>;
  return candidates.filter((n) => {
    try {
      const refs = JSON.parse(n.shared_teams || "[]");
      return Array.isArray(refs) && refs.some((r: any) => myTeamIds.has(r?.teamId));
    } catch {
      return false;
    }
  });
}

export async function listSharedNests(userId: string): Promise<Nest[]> {
  const db = getDb();
  // A server admin is NOT auto-shown every nest here. Administering a nest
  // (resolveNestPermission → 'admin') still grants ACCESS via a direct link,
  // but it must not surface another user's private nest in the admin's
  // dashboard — an admin only sees nests actually shared with them (below),
  // plus their own and the public/anonymous commons (listNests/listPublicNests).
  // Shared = collaborator grant OR active steward assignment (matched by
  // email, since steward rows may predate the account) OR a share grant on one
  // document/folder OR membership of a team shared onto the nest. Independent
  // paths to a nest the user doesn't own.
  //
  // Share grants join in here so a person shared ONE document finds it by
  // logging in instead of needing the direct link someone sent them — the nest
  // is listed, and every read past the card stays scoped to their grants
  // (middleware in app.ts + listNodesForCaller). Deliberately NOT added to
  // listVisibleNests: that feeds the work inbox and stats, where a nest-wide
  // review queue would surface documents the grantee cannot read.
  const direct = (await db.all(
    `SELECT DISTINCT n.* FROM nests n
       LEFT JOIN nest_collaborators nc
         ON nc.nest_id = n.id AND nc.user_id = ?
       LEFT JOIN users u ON u.id = ?
       LEFT JOIN stewards s
         ON s.nest_id = n.id AND s.is_active = 1
        AND LOWER(s.user_email) = LOWER(u.email)
       LEFT JOIN grants g
         ON g.nest_id = n.id AND g.user_id = ?
       WHERE n.user_id != ?
         AND ${LIVE_ONLY_N}
         AND (nc.user_id IS NOT NULL OR s.id IS NOT NULL OR g.id IS NOT NULL)
       ORDER BY n.created_at DESC`,
    [userId, userId, userId, userId],
  )) as Nest[];

  // Fold in team-shared nests, deduped by id. Re-sort newest-first so the
  // merged list keeps the same ordering as the direct query.
  const seen = new Set(direct.map((n) => n.id));
  for (const n of await nestsSharedViaTeams(userId)) {
    if (!seen.has(n.id)) {
      direct.push(n);
      seen.add(n.id);
    }
  }

  // Server admins additionally see the anonymous commons — nests owned by the
  // ANON user (the ungoverned shared workspace), even if a commons nest was
  // flipped private. This is the ONLY non-shared, non-owned category an admin
  // is shown: another real user's private nest still stays hidden.
  if (await isServerAdminUserId(userId)) {
    const anon = (await db.all(
      `SELECT * FROM nests WHERE user_id = ? AND ${LIVE_ONLY}
        ORDER BY created_at DESC`,
      [ANON_USER_ID],
    )) as Nest[];
    for (const n of anon) {
      if (!seen.has(n.id)) {
        direct.push(n);
        seen.add(n.id);
      }
    }
  }

  direct.sort((a, b) =>
    a.created_at === b.created_at ? 0 : a.created_at < b.created_at ? 1 : -1,
  );
  return direct;
}

/**
 * Every nest the caller can see — owned + shared — in ONE query instead of
 * listNests + listSharedNests' separate round trips. This is the union of
 * those two, so it stays faithful to their access rules:
 *   - owned                → n.user_id = caller (or anon-owned in open mode)
 *   - collaborator grant   → nest_collaborators row
 *   - active steward       → stewards row matched by email
 *   - team-shared          → folded in from nestsSharedViaTeams (JSON, not SQL)
 *
 * A server admin is NOT auto-shown every nest — same rule as listSharedNests:
 * administering a nest grants access via direct link, not dashboard/inbox
 * visibility of another user's private nest.
 *
 * Callers that stitched owned+shared themselves (/me/work inbox, /stats) should
 * use this — it also dedupes, which the naive concat did not.
 *
 * `readable` widens the union to the two remaining paths that grant READ but no
 * membership — visibility='public' (the dashboard's listPublicNests) and a
 * document/folder share grant (the `grants` table, which lets a grantee open the
 * nest shell, list its nodes and run its search). Read surfaces like global
 * search need both, or a Viewer's nests are silently skipped even though every
 * one of their documents opens fine by direct link. Both ride on the SAME query
 * — one join and two ORs, deduped by the existing DISTINCT — so this costs no
 * extra round trip and no extra pass over the rows.
 *
 * Off by default: the work inbox and /stats are about nests you're involved in,
 * where every public nest on the server would be noise.
 */
export async function listVisibleNests(
  userId: string,
  opts: { readable?: boolean } = {},
): Promise<Nest[]> {
  const db = getDb();

  // Owned OR collaborator OR active-steward — the same join listSharedNests
  // uses, but with `n.user_id = ?` folded into the WHERE so owned rows come
  // back in the same pass. Anon-owned nests (the ungoverned commons) join in
  // under open mode OR for a server admin — the only non-owned, non-shared
  // category an admin sees; another user's private nest still stays hidden.
  const includeAnon =
    config.AUTH_MODE === "open" || (await isServerAdminUserId(userId));
  // Param order follows the `?`s in the SQL below: nc, u, [g], n.user_id, [anon].
  const params = [
    userId,
    userId,
    ...(opts.readable ? [userId] : []),
    userId,
    ...(includeAnon ? [ANON_USER_ID] : []),
  ];
  const rows = (await db.all(
    `SELECT DISTINCT n.* FROM nests n
       LEFT JOIN nest_collaborators nc
         ON nc.nest_id = n.id AND nc.user_id = ?
       LEFT JOIN users u ON u.id = ?
       LEFT JOIN stewards s
         ON s.nest_id = n.id AND s.is_active = 1
        AND LOWER(s.user_email) = LOWER(u.email)
       ${opts.readable ? "LEFT JOIN grants g ON g.nest_id = n.id AND g.user_id = ?" : ""}
      WHERE ${LIVE_ONLY_N}
        AND (n.user_id = ?
         OR nc.user_id IS NOT NULL
         OR s.id IS NOT NULL
         ${opts.readable ? "OR g.id IS NOT NULL OR n.visibility = 'public'" : ""}
         ${includeAnon ? "OR n.user_id = ?" : ""})
      ORDER BY n.created_at DESC`,
    params,
  )) as Nest[];

  // Team-shared nests live as JSON (team roster + share refs), so they can't
  // join in SQL — fold them in separately, deduped by id.
  const seen = new Set(rows.map((n) => n.id));
  for (const n of await nestsSharedViaTeams(userId)) {
    if (!seen.has(n.id)) {
      rows.push(n);
      seen.add(n.id);
    }
  }
  return rows;
}

/** Public nests not owned/shared by caller. Route dedupes vs listNests. */
export async function listPublicNests(userId: string): Promise<Nest[]> {
  const db = getDb();
  return (await db.all(
    `SELECT n.* FROM nests n
       WHERE n.visibility = 'public'
         AND ${LIVE_ONLY_N}
         AND n.user_id != ?
         AND NOT EXISTS (
           SELECT 1 FROM nest_collaborators nc
           WHERE nc.nest_id = n.id AND nc.user_id = ?
         )
       ORDER BY n.created_at DESC`,
    [userId, userId],
  )) as Nest[];
}

export async function getNest(nestId: string): Promise<Nest | null> {
  const db = getDb();
  return (
    ((await db.get("SELECT * FROM nests WHERE id = ?", [nestId])) as Nest) ||
    null
  );
}

export async function deleteNest(nestId: string): Promise<void> {
  const db = getDb();

  // Foreign-key CASCADE handles most of this (see migrations.ts) but the
  // explicit deletes inside a single transaction give us two guarantees:
  //   1. Behaviour stays correct even if a future migration drops a CASCADE
  //      clause or a connection forgets to enable `foreign_keys = ON`.
  //   2. The whole wipe is atomic — a crash mid-delete can't leave dangling
  //      stewards / versions / review rows pointing at a removed nest.
  await db.transaction(async (tx) => {
    const id = nestId;
    await tx.run("DELETE FROM approved_versions WHERE nest_id = ?", [id]);
    await tx.run("DELETE FROM node_versions WHERE nest_id = ?", [id]);
    await tx.run("DELETE FROM review_requests WHERE nest_id = ?", [id]);
    await tx.run("DELETE FROM stewards WHERE nest_id = ?", [id]);
    await tx.run("DELETE FROM nest_collaborators WHERE nest_id = ?", [id]);
    // node_tag_index is FK-cascaded too, but explicit keeps the contract
    // visible. Wrapped in try/catch because the table is only created by
    // the tag-index migration — older DBs predate it.
    try {
      await tx.run("DELETE FROM node_tag_index WHERE nest_id = ?", [id]);
    } catch {
      // Table not present on legacy DBs — fine, nothing to clean.
    }
    await tx.run("DELETE FROM api_keys WHERE nest_id = ?", [id]);
    // Pins are FK-cascaded too; explicit for the same reason as the rows above,
    // and wrapped because a DB predating the pins migration has no such table.
    try {
      await tx.run("DELETE FROM nest_pins WHERE nest_id = ?", [id]);
    } catch {
      // Table not present on legacy DBs — nothing to clean.
    }
    await tx.run("DELETE FROM nests WHERE id = ?", [id]);
  });

  // Reclaim the on-disk folder at its resolved location (see shared/paths.ts —
  // `<NEST_STORAGE_ROOT>/<id>`, default `<DATA_ROOT>/nests/<id>`). Every nest
  // (default or imported) lives there — imported nests copied their files in,
  // so removing the folder never touches the user's original (untouched)
  // source. Failure here is non-fatal: the DB rows are already gone, so the
  // nest is unreachable from the app either way; an orphaned directory is
  // harmless.
  const path = resolveNestPath(nestId);
  try {
    // Async, not rmSync: on a Cloud Storage mount every unlink is a network
    // round trip, and the sync call held the event loop for the whole walk —
    // minutes on a large nest, stalling every other request on the instance.
    await rm(path, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[nests] failed to remove nest directory ${path}:`, err);
  }

  trackEvent("nest.delete", { nestId });
}
