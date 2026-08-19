/**
 * Publish — governed, gated public hosting of a single document.
 *
 * Distinct from grants (authenticated per-user doc sharing) and from nest
 * visibility (whole-nest public read). A `publish` exposes ONE node as a
 * standalone page at a stable, unguessable `/p/<slug>` URL under a chosen
 * access mode:
 *   - public : no auth, anyone with the link.
 *   - code   : one shared passcode unlocks it (room / webinar / QR).
 *   - email  : viewer enters an email, gets a one-time magic link, access logged.
 *   - invite : same magic-link flow, but only allow-listed emails get a link.
 *
 * All gated modes establish a short-lived cookie-backed `session` grant after
 * the gate passes. Every served view is logged (`view` grant) so an owner can
 * see who opened it. Publishes are revocable and can carry an expiry. The
 * published bytes are always the owner's own governed content — publishing is
 * an explicit owner/admin act (gated at the route via canManageStewards).
 *
 * The `access_grant` table is the one store for every per-publish record,
 * discriminated by `kind`:
 *   invite  — an allow-listed email (no token; minted a link on request)
 *   link    — a one-time magic-link token (token_hash + email, burned on use)
 *   session — a cookie-backed viewing session (token_hash, expiry)
 *   view    — an access-log entry (email may be null for public views)
 */
import { v4 as uuid } from "uuid";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { getDb } from "../db/client.js";
import { ValidationError } from "../shared/errors.js";
import { normalizeEmail } from "../shared/email.js";
import { assertSafeNodeId } from "../shared/node-id.js";

export type PublishMode = "public" | "email" | "code" | "invite";

export interface PublishRow {
  id: string;
  nest_id: string;
  node_id: string;
  slug: string;
  access_mode: PublishMode;
  code_hash: string | null;
  comments_enabled: number; // 0 | 1
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

const MODES: readonly PublishMode[] = ["public", "email", "code", "invite"];
const LINK_TTL_SECONDS = 60 * 60; // magic link valid 1h
const SESSION_TTL_SECONDS = 24 * 60 * 60; // viewing session 24h

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Constant-time compare of two hex-encoded digests of equal length. */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** URL-safe unguessable slug (~11 chars of base64url over 8 random bytes). */
function newSlug(): string {
  return randomBytes(8).toString("base64url");
}
function newToken(): string {
  return randomBytes(32).toString("hex");
}
function nowIso(): string {
  return new Date().toISOString();
}
function isPast(iso: string | null): boolean {
  return !!iso && new Date(iso).getTime() < Date.now();
}

/** A publish is servable only while it is neither revoked nor expired. */
export function isLivePublish(row: PublishRow | undefined): row is PublishRow {
  return !!row && !row.revoked_at && !isPast(row.expires_at);
}

/** Owner-safe view of a publish row — never leaks the code hash. */
export function toPublishResponse(row: PublishRow) {
  return {
    id: row.id,
    slug: row.slug,
    node_id: row.node_id,
    access_mode: row.access_mode,
    comments_enabled: row.comments_enabled === 1,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
  };
}

// ─── Management (owner/admin only — gated at the route) ──────────────────

export async function createPublish(params: {
  nestId: string;
  nodeId: string;
  mode: PublishMode;
  commentsEnabled?: boolean;
  code?: string | null;
  allowlist?: string[];
  expiresAt?: string | null;
  createdBy: string;
}): Promise<PublishRow> {
  const { nestId, mode, createdBy } = params;
  const nodeId = (params.nodeId || "").trim();
  if (!MODES.includes(mode)) {
    throw new ValidationError("access_mode must be public | email | code | invite");
  }
  if (!nodeId) throw new ValidationError("node_id is required");
  // /p bypasses the central node-id chokepoint (it is not a /nests/:id/nodes
  // route and the id arrives in the body), so validate containment here — the
  // engine's document read does no path check of its own.
  assertSafeNodeId(nodeId);
  if (mode === "code" && !params.code?.trim()) {
    throw new ValidationError("code is required for a code-gated publish");
  }
  if (params.expiresAt && Number.isNaN(new Date(params.expiresAt).getTime())) {
    throw new ValidationError("expires_at must be an ISO date");
  }

  const db = getDb();
  const id = uuid();
  const slug = newSlug();
  const created = nowIso();
  const codeHash = mode === "code" && params.code ? sha256Hex(params.code.trim()) : null;

  await db.run(
    `INSERT INTO publish
       (id, nest_id, node_id, slug, access_mode, code_hash, comments_enabled,
        created_by, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      nestId,
      nodeId,
      slug,
      mode,
      codeHash,
      params.commentsEnabled ? 1 : 0,
      createdBy,
      created,
      params.expiresAt ?? null,
    ],
  );

  if (mode === "invite") {
    for (const raw of params.allowlist ?? []) {
      const email = normalizeEmail(raw);
      if (!email) continue;
      await db.run(
        `INSERT INTO access_grant (id, publish_id, kind, email, token_hash, expires_at, used_at, created_at)
         VALUES (?, ?, 'invite', ?, NULL, NULL, NULL, ?)`,
        [uuid(), id, email, created],
      );
    }
  }

  const row = await getPublishBySlug(slug);
  if (!row) throw new ValidationError("failed to create publish");
  return row;
}

export async function getPublishBySlug(slug: string): Promise<PublishRow | undefined> {
  return (await getDb().get("SELECT * FROM publish WHERE slug = ?", [slug])) as
    | PublishRow
    | undefined;
}

export async function getPublishById(
  nestId: string,
  id: string,
): Promise<PublishRow | undefined> {
  return (await getDb().get("SELECT * FROM publish WHERE id = ? AND nest_id = ?", [
    id,
    nestId,
  ])) as PublishRow | undefined;
}

export async function listPublish(nestId: string): Promise<PublishRow[]> {
  return (await getDb().all(
    "SELECT * FROM publish WHERE nest_id = ? ORDER BY created_at DESC",
    [nestId],
  )) as PublishRow[];
}

/** Revoke (soft) — the link stops working immediately. Returns false if the
 *  publish is unknown or was already revoked. */
export async function revokePublish(nestId: string, id: string): Promise<boolean> {
  const res = await getDb().run(
    "UPDATE publish SET revoked_at = ? WHERE id = ? AND nest_id = ? AND revoked_at IS NULL",
    [nowIso(), id, nestId],
  );
  return res.changes > 0;
}

// ─── Gate primitives (used by the public /p render routes) ───────────────

export function verifyCode(row: PublishRow, code: string): boolean {
  if (row.access_mode !== "code" || !row.code_hash) return false;
  return safeEqualHex(row.code_hash, sha256Hex((code || "").trim()));
}

export async function isAllowlisted(publishId: string, email: string): Promise<boolean> {
  const e = normalizeEmail(email);
  if (!e) return false;
  const row = (await getDb().get(
    "SELECT 1 AS x FROM access_grant WHERE publish_id = ? AND kind = 'invite' AND email = ? LIMIT 1",
    [publishId, e],
  )) as { x: number } | undefined;
  return !!row;
}

/** Mint a one-time magic-link token for `email`; store its hash. */
export async function mintMagicLink(publishId: string, email: string): Promise<string> {
  const e = normalizeEmail(email);
  const token = newToken();
  const expires = new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString();
  await getDb().run(
    `INSERT INTO access_grant (id, publish_id, kind, email, token_hash, expires_at, used_at, created_at)
     VALUES (?, ?, 'link', ?, ?, ?, NULL, ?)`,
    [uuid(), publishId, e, sha256Hex(token), expires, nowIso()],
  );
  return token;
}

/** Consume a magic-link token: returns the email and burns the token when the
 *  token is valid, unused, and unexpired; otherwise null. */
export async function consumeMagicLink(
  publishId: string,
  token: string,
): Promise<string | null> {
  if (!token) return null;
  const row = (await getDb().get(
    "SELECT id, email, expires_at, used_at FROM access_grant WHERE publish_id = ? AND kind = 'link' AND token_hash = ?",
    [publishId, sha256Hex(token)],
  )) as
    | { id: string; email: string | null; expires_at: string | null; used_at: string | null }
    | undefined;
  if (!row || row.used_at || isPast(row.expires_at)) return null;
  const res = await getDb().run(
    "UPDATE access_grant SET used_at = ? WHERE id = ? AND used_at IS NULL",
    [nowIso(), row.id],
  );
  if (res.changes === 0) return null; // lost the race — already consumed
  return row.email;
}

/** Establish a cookie-backed viewing session; returns the raw cookie token. */
export async function createSession(
  publishId: string,
  email: string | null,
): Promise<string> {
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await getDb().run(
    `INSERT INTO access_grant (id, publish_id, kind, email, token_hash, expires_at, used_at, created_at)
     VALUES (?, ?, 'session', ?, ?, ?, NULL, ?)`,
    [uuid(), publishId, email, sha256Hex(token), expires, nowIso()],
  );
  return token;
}

export async function verifySession(publishId: string, token: string): Promise<boolean> {
  if (!token) return false;
  const row = (await getDb().get(
    "SELECT expires_at FROM access_grant WHERE publish_id = ? AND kind = 'session' AND token_hash = ?",
    [publishId, sha256Hex(token)],
  )) as { expires_at: string | null } | undefined;
  return !!row && !isPast(row.expires_at);
}

// ─── View log ────────────────────────────────────────────────────────────

export async function logView(publishId: string, email: string | null): Promise<void> {
  await getDb().run(
    `INSERT INTO access_grant (id, publish_id, kind, email, token_hash, expires_at, used_at, created_at)
     VALUES (?, ?, 'view', ?, NULL, NULL, NULL, ?)`,
    [uuid(), publishId, email, nowIso()],
  );
}

export async function listViews(
  publishId: string,
): Promise<Array<{ email: string | null; created_at: string }>> {
  return (await getDb().all(
    "SELECT email, created_at FROM access_grant WHERE publish_id = ? AND kind = 'view' ORDER BY created_at DESC LIMIT 500",
    [publishId],
  )) as Array<{ email: string | null; created_at: string }>;
}
