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
import { createHash, randomBytes } from "crypto";
import { getDb } from "../db/client.js";
import { engineCache } from "../nodes/engine.js";
import { hashPassword, verifyPassword } from "../auth/keys.js";
import { ValidationError } from "../shared/errors.js";
import { normalizeEmail } from "../shared/email.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { getApprovedVersion } from "../governance/version-service.js";
import { isEmailConfigured, sendEmailToRecipient } from "../notify/email.js";

export type PublishMode = "public" | "email" | "code" | "invite";

export interface PublishRow {
  id: string;
  nest_id: string;
  node_id: string;
  slug: string;
  access_mode: PublishMode;
  code_hash: string | null;
  comments_enabled: number; // 0 | 1
  watermark: number; // 0 | 1 — stamp the viewer's email across the page
  no_download: number; // 0 | 1 — discourage print/copy
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

/** The refusals the REST routes (publish-routes.ts) and the MCP tools
 *  (mcp/public-link-tools.ts) both give, so the two say the same thing. */
export const PUBLISH_FORBIDDEN =
  "Only a nest admin, the nest owner, or the server admin can publish documents.";
export const PUBLISH_NOT_FOUND = "Publish not found";

const MODES: readonly PublishMode[] = ["public", "email", "code", "invite"];
const LINK_TTL_SECONDS = 60 * 60; // magic link valid 1h
const SESSION_TTL_SECONDS = 24 * 60 * 60; // viewing session 24h

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Does this document exist in this nest? Documents live in engine storage,
 *  not a table, so this asks the same reader the published page will use. */
async function nodeExists(nestId: string, nodeId: string): Promise<boolean> {
  try {
    const { storage } = await engineCache.get(nestId);
    await storage.readDocument(nodeId);
    return true;
  } catch {
    return false;
  }
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
    watermark: row.watermark === 1,
    no_download: row.no_download === 1,
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
  watermark?: boolean;
  noDownload?: boolean;
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
  // Fail here rather than mint a slug for a node that does not exist — a typo
  // would otherwise hand back a link that 404s forever, with nothing on the
  // publish row to explain why.
  if (!(await nodeExists(nestId, nodeId))) {
    throw new ValidationError(`No such document in this nest: ${nodeId}`);
  }
  // Same rule, one step further: /p serves the APPROVED snapshot, never the
  // working copy (publish-render-routes.renderPublished), so a document that
  // has never been approved has nothing to serve and its link 404s for every
  // reader. Refuse the link instead of minting a dead one (CU-wdqcq01e73).
  if ((await getApprovedVersion(nestId, nodeId)) == null) {
    throw new ValidationError(
      "This document has no approved version, so a link to it would show nothing. Get it approved first, then publish.",
    );
  }

  const db = getDb();
  const id = uuid();
  const slug = newSlug();
  const created = nowIso();
  // A passcode is a human-chosen secret, so it gets the password treatment
  // (bcrypt), not the fast hash we use for high-entropy random tokens —
  // see the rationale in auth/keys.ts.
  const codeHash =
    mode === "code" && params.code ? await hashPassword(params.code.trim()) : null;

  await db.run(
    `INSERT INTO publish
       (id, nest_id, node_id, slug, access_mode, code_hash, comments_enabled,
        watermark, no_download, created_by, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      id,
      nestId,
      nodeId,
      slug,
      mode,
      codeHash,
      params.commentsEnabled ? 1 : 0,
      params.watermark ? 1 : 0,
      params.noDownload ? 1 : 0,
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

/** What a caller may ask for when publishing — the REST body, and the MCP
 *  tool's arguments under the same names. */
export interface PublishRequest {
  node_id?: string;
  access_mode?: string;
  comments_enabled?: boolean;
  watermark?: boolean;
  no_download?: boolean;
  code?: string | null;
  allowlist?: string[];
  expires_at?: string | null;
}

/**
 * Publish one document and hand back its link: everything POST
 * /nests/:id/publications does after its permission check, so the REST route
 * and the MCP tool (context_public_link_create) cannot drift apart. The caller
 * has already established that `userId` may publish in this nest.
 */
export async function publishDocumentLink(input: {
  nestId: string;
  userId: string;
  baseUrl: string;
  request: PublishRequest;
}): Promise<{ row: PublishRow; link: string }> {
  const { nestId, request: body } = input;
  const mode = (body.access_mode ?? "public") as PublishMode;
  // An email or invite link is opened ONLY by clicking a mailed magic link, so
  // without a mail transport it is a link nobody — not even the person who was
  // invited — can ever open. Refuse it rather than hand back a dead link.
  if ((mode === "email" || mode === "invite") && !isEmailConfigured()) {
    throw new ValidationError(
      "Email and invite links need email set up on this server (SMTP or AWS SES, plus NOTIFY_EMAIL_FROM). Use a public or passcode link instead.",
    );
  }
  const row = await createPublish({
    nestId,
    nodeId: (body.node_id ?? "").trim(),
    mode,
    commentsEnabled: !!body.comments_enabled,
    watermark: !!body.watermark,
    noDownload: !!body.no_download,
    code: body.code ?? null,
    allowlist: Array.isArray(body.allowlist) ? body.allowlist : [],
    expiresAt: body.expires_at ?? null,
    createdBy: input.userId,
  });
  const link = `${input.baseUrl}/p/${row.slug}`;

  // Invite mode is useless without the invitation: an allow-listed reader who
  // never receives the link has no way to reach the document. Fire-and-forget,
  // like every other notification here — a dead SMTP config must not fail the
  // publish (the link still works for anyone who has it).
  if (mode === "invite") {
    for (const email of await listAllowlist(row.id)) {
      void sendEmailToRecipient(email, {
        status: "shared",
        docTitle: "A document has been shared with you",
        path: "PromptOwl · ContextNest",
        permission: "view",
        link,
      }, { nestId });
    }
  }
  return { row, link };
}

/**
 * Every `/p/:slug` route resolves through here, so archiving the nest takes its
 * published links off the internet in one place — they answer the same
 * not-found page a revoked link does. Nothing is unpublished: restoring the
 * nest brings every link back live at the same URL.
 */
export async function getPublishBySlug(slug: string): Promise<PublishRow | undefined> {
  return (await getDb().get(
    `SELECT p.* FROM publish p
       JOIN nests n ON n.id = p.nest_id
      WHERE p.slug = ? AND n.archived_at IS NULL`,
    [slug],
  )) as PublishRow | undefined;
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

export async function verifyCode(row: PublishRow, code: string): Promise<boolean> {
  if (row.access_mode !== "code" || !row.code_hash) return false;
  return (await verifyPassword((code || "").trim(), row.code_hash)).ok;
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
  // Re-check the allow-list at redemption, not just at send. The gate mints a
  // token for any address so that an invited and an uninvited attempt cost the
  // same (see the gate handler), and an allow-list can change between mint and
  // click. Enforcing here is what makes an undelivered token inert by
  // construction rather than merely undelivered.
  const publishRow = (await getDb().get("SELECT access_mode FROM publish WHERE id = ?", [
    publishId,
  ])) as { access_mode: PublishMode } | undefined;
  if (publishRow?.access_mode === "invite") {
    if (!row.email || !(await isAllowlisted(publishId, row.email))) return null;
  }
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

/** Resolve a session cookie to its viewer, or null when the token is unknown
 *  or expired. `email` is null for a code gate — a shared passcode identifies
 *  nobody. Returning the email (rather than a bare boolean) is what lets every
 *  view of an email/invite publish be logged against the person who opened it. */
export async function verifySession(
  publishId: string,
  token: string,
): Promise<{ email: string | null } | null> {
  if (!token) return null;
  const row = (await getDb().get(
    "SELECT email, expires_at FROM access_grant WHERE publish_id = ? AND kind = 'session' AND token_hash = ?",
    [publishId, sha256Hex(token)],
  )) as { email: string | null; expires_at: string | null } | undefined;
  if (!row || isPast(row.expires_at)) return null;
  return { email: row.email };
}

// ─── View log ────────────────────────────────────────────────────────────

export async function logView(publishId: string, email: string | null): Promise<void> {
  await getDb().run(
    `INSERT INTO access_grant (id, publish_id, kind, email, token_hash, expires_at, used_at, created_at)
     VALUES (?, ?, 'view', ?, NULL, NULL, NULL, ?)`,
    [uuid(), publishId, email, nowIso()],
  );
}

/** Allow-listed emails for an invite publish (owner-facing + invite sending). */
export async function listAllowlist(publishId: string): Promise<string[]> {
  const rows = (await getDb().all(
    "SELECT email FROM access_grant WHERE publish_id = ? AND kind = 'invite' ORDER BY created_at ASC",
    [publishId],
  )) as Array<{ email: string | null }>;
  return rows.map((r) => r.email ?? "").filter(Boolean);
}

export async function listViews(
  publishId: string,
): Promise<Array<{ email: string | null; created_at: string }>> {
  return (await getDb().all(
    "SELECT email, created_at FROM access_grant WHERE publish_id = ? AND kind = 'view' ORDER BY created_at DESC LIMIT 500",
    [publishId],
  )) as Array<{ email: string | null; created_at: string }>;
}
