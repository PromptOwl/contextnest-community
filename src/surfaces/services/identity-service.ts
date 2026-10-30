/**
 * Identity linking (PRD §4.11, M6, HR3): surface user ↔ Community user.
 *
 * - Explicit: the installing admin (OAuth callback, S2a) — no first-use confirm.
 * - Auto-match: created lazily on the user's first commit-class action, only
 *   when all six §4.11 conditions hold; computing it for the guard creates
 *   nothing.
 * - One-time link: 32 random bytes, stored as sha256, 15 min, single use,
 *   bound to (install, surface user). A mismatched email is refused and
 *   queued for an admin. Linking never runs the pending action.
 * - First-use confirm on the first commit-class action through an auto or
 *   one-time link; "That's not me" revokes and blocks auto-match.
 *
 * One active link per (install, surface user) and per (install, Community user).
 */
import { createHash, randomBytes } from "crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "../../db/client.js";
import { config } from "../../config.js";
import { parseOrgDomains, emailDomain } from "../../shared/access.js";

import { AppError, ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";
import type { SurfaceUserProfile } from "../contract.js";
import { autoMatchVerdict, firstUsePrompt, COMMIT_VERBS, type AutoMatchVerdict, type CommitVerb } from "../core/identity-rules.js";
import { getConnector } from "../registry.js";
import { invalidateInstallGuards } from "../invalidate.js";
import { getInstall, homeTenant, installRef, type InstallRow } from "./install-store.js";
import { recordNotice } from "./notices.js";
import { ORG_ID } from "../flags.js";

export const LINK_TOKEN_TTL_MS = 15 * 60_000;
/** At most this many one-time links per (install, surface user) per TTL window (L4). */
export const LINK_TOKENS_PER_WINDOW = 5;
/** At most this many admin link reviews per (install, surface user) per day (L4). */
export const LINK_REVIEWS_PER_DAY = 3;
export const USER_CACHE_TTL_MS = 24 * 60 * 60_000;

export type LinkMethod = "explicit" | "auto_email" | "one_time" | "admin_review";

export interface LinkRow {
  id: string;
  org_id: string;
  install_id: string;
  surface: string;
  surface_user_id: string;
  community_user_id: string;
  method: LinkMethod;
  status: "active" | "revoked";
  first_use_confirmed_at: string | null;
  surface_email_at_link: string | null;
  auto_match_blocked: number;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  created_at: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const nowIso = (now?: number) => new Date(now ?? Date.now()).toISOString();

async function installOrThrow(installId: string): Promise<InstallRow> {
  const i = await getInstall(installId);
  if (!i) throw new NotFoundError("Install not found");
  return i;
}

export async function activeLink(installId: string, surfaceUserId: string): Promise<LinkRow | null> {
  return (
    ((await getDb().get("SELECT * FROM surface_identity_links WHERE install_id = ? AND surface_user_id = ? AND status = 'active'", [
      installId,
      surfaceUserId,
    ])) as LinkRow | undefined) ?? null
  );
}

async function activeLinkForUser(installId: string, communityUserId: string): Promise<LinkRow | null> {
  return (
    ((await getDb().get("SELECT * FROM surface_identity_links WHERE install_id = ? AND community_user_id = ? AND status = 'active'", [
      installId,
      communityUserId,
    ])) as LinkRow | undefined) ?? null
  );
}

async function isBlocked(installId: string, surfaceUserId: string): Promise<boolean> {
  const row = await getDb().get(
    "SELECT 1 AS hit FROM surface_identity_links WHERE install_id = ? AND surface_user_id = ? AND auto_match_blocked = 1 LIMIT 1",
    [installId, surfaceUserId],
  );
  return !!row;
}

// ─── surface user cache ────────────────────────────────────────────────────

function rowToProfile(r: any): SurfaceUserProfile {
  return {
    surface_user_id: r.surface_user_id,
    home_team_id: r.home_team_id ?? null,
    enterprise_id: r.enterprise_id ?? null,
    email: r.email ?? null,
    email_confirmed: r.email_confirmed === null || r.email_confirmed === undefined ? null : !!r.email_confirmed,
    is_restricted: !!r.is_restricted,
    is_ultra_restricted: !!r.is_ultra_restricted,
    is_stranger: !!r.is_stranger,
    is_bot: !!r.is_bot,
    deleted: !!r.deleted,
    user_role: r.user_role ?? null,
    display_name: r.display_name ?? null,
  };
}

async function upsertProfile(installId: string, p: SurfaceUserProfile): Promise<void> {
  const db = getDb();
  const now = nowIso();
  const vals = [
    p.home_team_id,
    p.enterprise_id,
    p.email,
    p.email_confirmed === null ? null : p.email_confirmed ? 1 : 0,
    p.is_restricted ? 1 : 0,
    p.is_ultra_restricted ? 1 : 0,
    p.is_stranger ? 1 : 0,
    p.is_bot ? 1 : 0,
    p.deleted ? 1 : 0,
    p.user_role,
    p.display_name,
    now,
  ];
  const updated = await db.run(
    `UPDATE surface_users_cache SET home_team_id = ?, enterprise_id = ?, email = ?, email_confirmed = ?, is_restricted = ?,
       is_ultra_restricted = ?, is_stranger = ?, is_bot = ?, deleted = ?, user_role = ?, display_name = ?, fetched_at = ?
     WHERE install_id = ? AND surface_user_id = ?`,
    [...vals, installId, p.surface_user_id],
  );
  if (updated.changes === 0) {
    await db.run(
      `INSERT INTO surface_users_cache (home_team_id, enterprise_id, email, email_confirmed, is_restricted, is_ultra_restricted,
         is_stranger, is_bot, deleted, user_role, display_name, fetched_at, install_id, surface_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...vals, installId, p.surface_user_id],
    );
  }
}

/** Cached profile (≤ 24h), else fetched through the connector and cached. */
export async function getProfile(installId: string, surfaceUserId: string, opts: { refresh?: boolean } = {}): Promise<SurfaceUserProfile | null> {
  const row = (await getDb().get("SELECT * FROM surface_users_cache WHERE install_id = ? AND surface_user_id = ?", [
    installId,
    surfaceUserId,
  ])) as any;
  if (row && !opts.refresh && Date.now() - Date.parse(row.fetched_at) < USER_CACHE_TTL_MS) return rowToProfile(row);
  // A forced refresh is strict: if the surface can't answer now, there is no
  // profile — never a stale cached one (re-review M6).
  const fallback = opts.refresh ? null : row ? rowToProfile(row) : null;
  const install = await getInstall(installId);
  const connector = install ? getConnector(install.surface) : null;
  if (!install || !connector) return fallback;
  let fetched: SurfaceUserProfile | null = null;
  try {
    fetched = await connector.userProfile(installRef(install), surfaceUserId);
  } catch {
    fetched = null;
  }
  if (!fetched) return fallback;
  await upsertProfile(installId, fetched);
  return fetched;
}

/**
 * `user_change` (AC-IDN-08): refresh the cache only. A changed email never
 * re-points or revokes an existing link. Guest/restricted changes can move
 * the guard, so this install's bindings are re-checked.
 */
export async function recordUserChange(installId: string, p: SurfaceUserProfile): Promise<void> {
  await upsertProfile(installId, p);
  await invalidateInstallGuards(installId);
}

// ─── auto-match ────────────────────────────────────────────────────────────

/** Verified domains: the deployment's OIDC sign-in allowlist, when set (V14). */
function verifiedDomains(): string[] {
  return config.OIDC_ALLOWED_DOMAINS;
}

/**
 * Community users in the install's owning org with this email
 * (case-insensitive). Self-hosted: the deployment is the org. Shared
 * deployment: the home nest's org domains bound it, and none → nobody.
 */
async function candidatesFor(install: InstallRow, email: string) {
  const rows = (await getDb().all(
    "SELECT id, email, email_verified_at FROM users WHERE LOWER(email) = ? AND COALESCE(is_service, 0) = 0",
    [email.trim().toLowerCase()],
  )) as Array<{ id: string; email: string; email_verified_at: string | null }>;
  let inOrg = rows;
  if (config.SHARED_DEPLOYMENT) {
    const nest = install.home_nest_id
      ? ((await getDb().get("SELECT org_domains FROM nests WHERE id = ?", [install.home_nest_id])) as { org_domains: string | null } | undefined)
      : undefined;
    const domains = parseOrgDomains(nest?.org_domains ?? null).map((d) => d.toLowerCase());
    inOrg = rows.filter((r) => {
      const d = emailDomain(r.email);
      return !!d && domains.includes(d);
    });
  }
  return inOrg.map((r) => ({ id: r.id, email: r.email, email_verified: !!r.email_verified_at }));
}

async function verdictFor(install: InstallRow, surfaceUserId: string, profile: SurfaceUserProfile | null): Promise<AutoMatchVerdict> {
  const blocked = await isBlocked(install.id, surfaceUserId);
  const candidates = profile?.email ? await candidatesFor(install, profile.email) : [];
  const v = autoMatchVerdict({
    profile,
    install: { surface: install.surface, home_team_id: homeTenant(install), enterprise_id: install.enterprise_id },
    candidates,
    verifiedDomains: verifiedDomains(),
    blocked,
  });
  if (!v.ok) return v;
  // One link per (install, Community user): someone already linked under a
  // different surface id is not auto-matched again.
  const existing = await activeLinkForUser(install.id, v.userId);
  if (existing && existing.surface_user_id !== surfaceUserId) return { ok: false, reason: "ambiguous" };
  return v;
}

export async function evaluateAutoMatch(installId: string, surfaceUserId: string): Promise<AutoMatchVerdict> {
  const install = await installOrThrow(installId);
  return verdictFor(install, surfaceUserId, await getProfile(installId, surfaceUserId));
}

/**
 * The Community user a surface user maps to, for the guard and the
 * connector contract's resolveIdentity: active link, else a passing
 * auto-match. Creates nothing.
 */
export async function resolveIdentity(installId: string, surfaceUserId: string): Promise<string | null> {
  const link = await activeLink(installId, surfaceUserId);
  if (link) return link.community_user_id;
  const install = await getInstall(installId);
  if (!install) return null;
  const v = await verdictFor(install, surfaceUserId, await getProfile(installId, surfaceUserId));
  return v.ok ? v.userId : null;
}

// ─── link creation ─────────────────────────────────────────────────────────

async function createLink(input: {
  install: InstallRow;
  surfaceUserId: string;
  communityUserId: string;
  method: LinkMethod;
  confirmed: boolean;
  surfaceEmail?: string | null;
}): Promise<LinkRow> {
  const id = uuid();
  const now = nowIso();
  try {
    await getDb().run(
      `INSERT INTO surface_identity_links (id, org_id, install_id, surface, surface_user_id, community_user_id, method, status,
         first_use_confirmed_at, surface_email_at_link, auto_match_blocked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, ?)`,
      [
        id,
        ORG_ID,
        input.install.id,
        input.install.surface,
        input.surfaceUserId,
        input.communityUserId,
        input.method,
        input.confirmed ? now : null,
        input.surfaceEmail ?? null,
        now,
        now,
      ],
    );
  } catch {
    throw new ConflictError("That surface user is already linked.");
  }
  await invalidateInstallGuards(input.install.id);
  if (input.method !== "explicit") {
    await recordNotice({
      kind: "link_created",
      audience: "user",
      recipientUserId: input.communityUserId,
      detail: { channel: "email", method: input.method, surface: input.install.surface },
      subject: "Your account was linked to a chat identity",
      text: `Your ContextNest account was linked to a ${input.install.surface} user in a connected workspace (${input.method === "auto_email" ? "matched by your verified email" : "through a sign-in link"}). Not you? Revoke it from the Surfaces page or ask your administrator.`,
    });
  }
  return (await getDb().get("SELECT * FROM surface_identity_links WHERE id = ?", [id])) as LinkRow;
}

/** Explicit admin self-link (and admin-created links). No first-use confirm. */
export async function linkExplicit(input: { installId: string; surfaceUserId: string; communityUserId: string }): Promise<LinkRow> {
  const install = await installOrThrow(input.installId);
  const existing = await activeLink(install.id, input.surfaceUserId);
  if (existing) {
    if (existing.community_user_id === input.communityUserId) return existing;
    throw new ConflictError("That surface user is already linked to another account.");
  }
  const other = await activeLinkForUser(install.id, input.communityUserId);
  if (other) throw new ConflictError("That account is already linked to another user in this workspace.");
  return createLink({ install, surfaceUserId: input.surfaceUserId, communityUserId: input.communityUserId, method: "explicit", confirmed: true });
}

/**
 * The Slack OAuth callback's last step (S2a calls this after verifying
 * `state` and ownership): the installer's `authed_user.id` → the admin whose
 * session minted the state (AC-IDN-01).
 */
export function completeInstallerLink(input: { installId: string; authedUserId: string; communityUserId: string }): Promise<LinkRow> {
  return linkExplicit({ installId: input.installId, surfaceUserId: input.authedUserId, communityUserId: input.communityUserId });
}

// ─── one-time link tokens ──────────────────────────────────────────────────

export async function issueLinkToken(input: { installId: string; surfaceUserId: string; now?: number }): Promise<string> {
  await installOrThrow(input.installId);
  const now = input.now ?? Date.now();
  const recent = (await getDb().get(
    "SELECT COUNT(*) AS n FROM surface_link_tokens WHERE install_id = ? AND surface_user_id = ? AND purpose = 'link' AND created_at > ?",
    [input.installId, input.surfaceUserId, nowIso(now - LINK_TOKEN_TTL_MS)],
  )) as { n: number | string } | undefined;
  if (Number(recent?.n ?? 0) >= LINK_TOKENS_PER_WINDOW) {
    throw new AppError(429, "Too many sign-in links were requested. Try again in a few minutes.");
  }
  const token = randomBytes(32).toString("base64url");
  await getDb().run(
    `INSERT INTO surface_link_tokens (token_hash, purpose, install_id, surface_user_id, expires_at, created_at)
     VALUES (?, 'link', ?, ?, ?, ?)`,
    [sha256(token), input.installId, input.surfaceUserId, nowIso((input.now ?? Date.now()) + LINK_TOKEN_TTL_MS), nowIso(input.now)],
  );
  return token;
}

export function linkUrl(token: string): string {
  const base = (config.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  return `${base}/link/${token}`;
}

async function tokenRow(token: string) {
  return (await getDb().get("SELECT * FROM surface_link_tokens WHERE token_hash = ? AND purpose = 'link'", [sha256(token)])) as
    | { token_hash: string; install_id: string; surface_user_id: string; expires_at: string; used_at: string | null }
    | undefined;
}

/** What the link page shows: both identities, so a forwarded link is obvious. */
export async function describeLinkToken(
  token: string,
  userId: string,
  now = Date.now(),
): Promise<{ ok: true; surface_identity: string; community_identity: string } | { ok: false; reason: "invalid" | "expired" | "used" }> {
  const row = await tokenRow(token);
  if (!row) return { ok: false, reason: "invalid" };
  if (row.used_at) return { ok: false, reason: "used" };
  if (Date.parse(row.expires_at) <= now) return { ok: false, reason: "expired" };
  const install = await getInstall(row.install_id);
  const p = await getProfile(row.install_id, row.surface_user_id);
  const u = (await getDb().get("SELECT email FROM users WHERE id = ?", [userId])) as { email?: string } | undefined;
  const surfaceName = p?.display_name ? `@${p.display_name}` : row.surface_user_id;
  return {
    ok: true,
    surface_identity: `${install?.surface === "teams" ? "Teams" : "Slack"} user ${surfaceName} (${p?.email ?? "email unknown"})`,
    community_identity: `signed in as ${u?.email ?? "unknown"}`,
  };
}

export type RedeemResult =
  | { ok: true; linked: true; executed: false; message: string; linkId: string }
  | { ok: false; reason: "invalid" | "expired" | "used" | "mismatch" | "already_linked"; review_id?: string; message: string };

export const CLICK_AGAIN = "Linked. Nothing was approved or rejected yet: go back and click the button again.";

export async function redeemLinkToken(input: { token: string; userId: string; now?: number }): Promise<RedeemResult> {
  const now = input.now ?? Date.now();
  const row = await tokenRow(input.token);
  if (!row) return { ok: false, reason: "invalid", message: "This link isn't valid." };
  if (row.used_at) return { ok: false, reason: "used", message: "This link was already used." };
  if (Date.parse(row.expires_at) <= now) return { ok: false, reason: "expired", message: "This link has expired. Click the button again for a new one." };
  // Single use: claim it before anything else (compare-and-set).
  const claimed = await getDb().run("UPDATE surface_link_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL", [
    nowIso(now),
    row.token_hash,
  ]);
  if (claimed.changes === 0) return { ok: false, reason: "used", message: "This link was already used." };

  const install = await installOrThrow(row.install_id);
  const finish = (outcome: string, userId: string | null = input.userId) =>
    getDb().run("UPDATE surface_link_tokens SET outcome = ?, community_user_id = ? WHERE token_hash = ?", [outcome, userId, row.token_hash]);

  // Fresh from the surface, never the 24h cache: the email must be one the
  // surface itself has confirmed (M6), exactly as auto-match requires.
  const p = await getProfile(install.id, row.surface_user_id, { refresh: true });
  const u = (await getDb().get("SELECT email, email_verified_at FROM users WHERE id = ?", [input.userId])) as
    | { email: string; email_verified_at: string | null }
    | undefined;
  const surfaceEmail = p?.email_confirmed === true ? (p.email?.trim().toLowerCase() ?? null) : null;
  const userEmail = u?.email?.trim().toLowerCase() ?? null;
  const matches = !!surfaceEmail && !!userEmail && !!u?.email_verified_at && surfaceEmail === userEmail;
  if (!matches) {
    let reviewId: string | undefined;
    const today = (await getDb().get(
      "SELECT COUNT(*) AS n FROM surface_link_reviews WHERE install_id = ? AND surface_user_id = ? AND created_at > ?",
      [install.id, row.surface_user_id, nowIso(now - 24 * 60 * 60_000)],
    )) as { n: number | string } | undefined;
    if (Number(today?.n ?? 0) < LINK_REVIEWS_PER_DAY) {
      reviewId = uuid();
      await getDb().run(
        `INSERT INTO surface_link_reviews (id, install_id, surface_user_id, surface_email, community_user_id, community_email, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [reviewId, install.id, row.surface_user_id, p?.email ?? null, input.userId, u?.email ?? null, nowIso(now), nowIso(now)],
      );
    }
    await finish("refused_review");
    return {
      ok: false,
      reason: "mismatch",
      review_id: reviewId,
      message: "These accounts couldn't be matched, so they were not linked. An administrator has been asked to review it.",
    };
  }
  if ((await activeLink(install.id, row.surface_user_id)) || (await activeLinkForUser(install.id, input.userId))) {
    await finish("refused_already_linked");
    return { ok: false, reason: "already_linked", message: "One of these accounts is already linked." };
  }
  const link = await createLink({
    install,
    surfaceUserId: row.surface_user_id,
    communityUserId: input.userId,
    method: "one_time",
    confirmed: false,
    surfaceEmail: p?.email ?? null,
  });
  await finish("linked");
  return { ok: true, linked: true, executed: false, message: CLICK_AGAIN, linkId: link.id };
}

// ─── the actor behind a commit-class click ─────────────────────────────────

export type ActorResolution =
  | { status: "rate_limited"; message: string }
  | { status: "ok"; userId: string; linkId: string }
  | { status: "confirm"; linkId: string; userId: string; verb: CommitVerb; prompt: string }
  | { status: "needs_link"; token: string; url: string; reason: string };

async function confirmPrompt(link: LinkRow, verb: CommitVerb) {
  const u = (await getDb().get("SELECT name, email FROM users WHERE id = ?", [link.community_user_id])) as { name: string | null; email: string };
  return firstUsePrompt(verb, { name: u?.name ?? null, email: u?.email ?? "" });
}

function assertVerb(action: string): CommitVerb {
  if (!(COMMIT_VERBS as readonly string[]).includes(action)) throw new ValidationError(`Unknown action: ${action}`);
  return action as CommitVerb;
}

/**
 * Who is acting when a surface user clicks a commit-class action. An active
 * link → that user (first-use confirm pending for auto/one-time links). No
 * link → auto-match (creating the auto_email link, with confirm) → otherwise
 * a one-time link.
 */
export async function resolveActor(input: { installId: string; surfaceUserId: string; action: string; now?: number }): Promise<ActorResolution> {
  const verb = assertVerb(input.action);
  const install = await installOrThrow(input.installId);
  let link = await activeLink(install.id, input.surfaceUserId);
  if (!link) {
    const profile = await getProfile(install.id, input.surfaceUserId);
    const v = await verdictFor(install, input.surfaceUserId, profile);
    if (v.ok) {
      try {
        link = await createLink({
          install,
          surfaceUserId: input.surfaceUserId,
          communityUserId: v.userId,
          method: "auto_email",
          confirmed: false,
          surfaceEmail: profile?.email ?? null,
        });
      } catch {
        link = await activeLink(install.id, input.surfaceUserId); // a concurrent click linked it
      }
    }
    if (!link) {
      let token: string;
      try {
        token = await issueLinkToken({ installId: install.id, surfaceUserId: input.surfaceUserId, now: input.now });
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 429) return { status: "rate_limited", message: err.message };
        throw err;
      }
      return { status: "needs_link", token, url: linkUrl(token), reason: v.ok ? "conflict" : v.reason };
    }
  }
  const needsConfirm = (link.method === "auto_email" || link.method === "one_time") && !link.first_use_confirmed_at;
  if (needsConfirm) {
    return { status: "confirm", linkId: link.id, userId: link.community_user_id, verb, prompt: await confirmPrompt(link, verb) };
  }
  return { status: "ok", userId: link.community_user_id, linkId: link.id };
}

/**
 * The first-use confirm's answer (N3). "yes" confirms the link and hands
 * back the ORIGINAL action — the caller continues exactly that flow (a Reject
 * goes to the reason step, never to approve). "not_me" executes nothing,
 * revokes the link, blocks auto-match and tells the org admins.
 */
export async function confirmFirstUse(input: {
  linkId: string;
  action: string;
  answer: "yes" | "not_me";
}): Promise<{ status: "continue"; action: CommitVerb; userId: string } | { status: "revoked"; executed: false }> {
  const verb = assertVerb(input.action);
  const link = (await getDb().get("SELECT * FROM surface_identity_links WHERE id = ?", [input.linkId])) as LinkRow | undefined;
  if (!link || link.status !== "active") throw new NotFoundError("Link not found");
  if (input.answer === "yes") {
    await getDb().run("UPDATE surface_identity_links SET first_use_confirmed_at = ?, updated_at = ? WHERE id = ? AND first_use_confirmed_at IS NULL", [
      nowIso(),
      nowIso(),
      link.id,
    ]);
    return { status: "continue", action: verb, userId: link.community_user_id };
  }
  await revokeLink({ linkId: link.id, byUserId: null, reason: "not_me" });
  await recordNotice({
    kind: "link_disowned",
    audience: "admins",
    detail: { surface: link.surface, method: link.method },
    subject: "A linked chat identity was disowned",
    text: "Someone who was matched to a ContextNest account answered \"That's not me\". The link was revoked and automatic matching is blocked for that chat user until an administrator clears it on the Surfaces page.",
  });
  return { status: "revoked", executed: false };
}

// ─── admin surface ─────────────────────────────────────────────────────────

/** Revoke (immediate). Any revoke blocks auto-match for the pair until an admin clears it. */
export async function revokeLink(input: { linkId: string; byUserId: string | null; reason?: string | null }): Promise<LinkRow> {
  const link = (await getDb().get("SELECT * FROM surface_identity_links WHERE id = ?", [input.linkId])) as LinkRow | undefined;
  if (!link) throw new NotFoundError("Link not found");
  if (link.status === "active") {
    await getDb().run(
      `UPDATE surface_identity_links SET status = 'revoked', auto_match_blocked = 1, revoked_at = ?, revoked_by = ?, revoke_reason = ?, updated_at = ?
       WHERE id = ?`,
      [nowIso(), input.byUserId, input.reason ?? null, nowIso(), link.id],
    );
    await invalidateInstallGuards(link.install_id);
  }
  return (await getDb().get("SELECT * FROM surface_identity_links WHERE id = ?", [link.id])) as LinkRow;
}

export async function clearAutoMatchBlock(installId: string, surfaceUserId: string): Promise<number> {
  const r = await getDb().run(
    "UPDATE surface_identity_links SET auto_match_blocked = 0, updated_at = ? WHERE install_id = ? AND surface_user_id = ? AND auto_match_blocked = 1",
    [nowIso(), installId, surfaceUserId],
  );
  await invalidateInstallGuards(installId);
  return r.changes;
}

export async function getLink(id: string): Promise<LinkRow | null> {
  return ((await getDb().get("SELECT * FROM surface_identity_links WHERE id = ?", [id])) as LinkRow | undefined) ?? null;
}

export async function listLinks(filter: { communityUserId?: string } = {}): Promise<LinkRow[]> {
  return filter.communityUserId
    ? ((await getDb().all("SELECT * FROM surface_identity_links WHERE community_user_id = ? ORDER BY created_at DESC", [filter.communityUserId])) as LinkRow[])
    : ((await getDb().all("SELECT * FROM surface_identity_links ORDER BY created_at DESC")) as LinkRow[]);
}

export async function listLinkReviews(status: string | null = "pending") {
  return status
    ? await getDb().all("SELECT * FROM surface_link_reviews WHERE status = ? ORDER BY created_at DESC", [status])
    : await getDb().all("SELECT * FROM surface_link_reviews ORDER BY created_at DESC");
}

export async function decideLinkReview(input: { reviewId: string; decision: "approve" | "deny"; byUserId: string }) {
  const r = (await getDb().get("SELECT * FROM surface_link_reviews WHERE id = ?", [input.reviewId])) as any;
  if (!r) throw new NotFoundError("Link review not found");
  if (r.status !== "pending") throw new ConflictError("This review was already decided.");
  if (input.decision !== "approve" && input.decision !== "deny") throw new ValidationError("decision must be approve or deny");
  const claimed = await getDb().run(
    "UPDATE surface_link_reviews SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    [input.decision === "approve" ? "approved" : "denied", input.byUserId, nowIso(), nowIso(), r.id],
  );
  if (claimed.changes === 0) throw new ConflictError("This review was already decided.");
  let link: LinkRow | null = null;
  if (input.decision === "approve") {
    const install = await installOrThrow(r.install_id);
    if ((await activeLink(install.id, r.surface_user_id)) || (await activeLinkForUser(install.id, r.community_user_id))) {
      throw new ConflictError("One of these accounts is already linked.");
    }
    link = await createLink({
      install,
      surfaceUserId: r.surface_user_id,
      communityUserId: r.community_user_id,
      method: "admin_review",
      confirmed: false,
      surfaceEmail: r.surface_email,
    });
  }
  return { review: await getDb().get("SELECT * FROM surface_link_reviews WHERE id = ?", [r.id]), link };
}

/**
 * Retention for one-time links and link reviews (L4), run from the existing
 * hourly retention sweep: tokens expired for more than a day, and decided
 * reviews older than 90 days.
 */
export async function purgeLinkArtifacts(now = Date.now()): Promise<{ tokens: number; reviews: number }> {
  const tokens = await getDb().run("DELETE FROM surface_link_tokens WHERE expires_at < ?", [nowIso(now - 24 * 60 * 60_000)]);
  const reviews = await getDb().run("DELETE FROM surface_link_reviews WHERE status <> 'pending' AND decided_at < ?", [
    nowIso(now - 90 * 24 * 60 * 60_000),
  ]);
  return { tokens: tokens.changes, reviews: reviews.changes };
}
