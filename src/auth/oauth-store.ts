/**
 * Storage for the MCP OAuth authorization server: clients, authorization
 * codes, and the access/refresh token pairs they become.
 *
 * SECRET HANDLING. Every credential here is 256 bits from `randomBytes` and is
 * stored as a plain SHA-256 hash, never in the clear — the same discipline
 * `api_keys` uses (`src/auth/keys.ts`). A slow KDF buys nothing against a
 * value with that much entropy; what matters is that a database dump contains
 * no usable token. Lookups are an indexed `WHERE hash = ?`, which is not
 * constant time, but timing on the hash of a random secret reveals nothing
 * an attacker can use.
 *
 * SINGLE USE. An authorization code is consumed by stamping `used_at` rather
 * than by deletion, so a replay is *detectable*: seeing an already-used code
 * means the code leaked, and OAuth 2.1 requires us to treat that as a
 * compromise of the whole grant, not merely to refuse the second exchange.
 * The same holds for a refresh token presented after it was rotated.
 */
import { randomBytes, createHash } from "crypto";
import { getDb } from "../db/client.js";
import { nowExpr } from "../db/sql.js";

/** Access tokens are short by design; a leaked one should expire quickly. */
export const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
/** Long enough that a connector keeps working without re-consent. */
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days
/** An authorization code should be redeemed within seconds, not minutes. */
export const CODE_TTL_SECONDS = 60;
/** How stale last_used_at may get before a resolution bothers to refresh it. */
const LAST_USED_THROTTLE_MINUTES = 5;
/** A client with no codes or tokens this long after registering is purged. */
const CLIENT_IDLE_DAYS = 30;

function secret(): string {
  return randomBytes(32).toString("hex");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

/** The `YYYY-MM-DD HH:MM:SS` UTC text nowExpr writes, offset from now. */
function sqlTime(secondsFromNow: number): string {
  return iso(secondsFromNow).slice(0, 19).replace("T", " ");
}

function expired(at: string | null | undefined): boolean {
  return !at || Date.parse(at) <= Date.now();
}

// ─── Clients ──────────────────────────────────────────────────────────────

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  kind: "dcr" | "cimd";
}

export async function upsertClient(c: OAuthClient): Promise<void> {
  const db = getDb();
  await db.run(
    `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, kind, last_seen_at)
     VALUES (?, ?, ?, ?, ${nowExpr(db)})
     ON CONFLICT(client_id) DO UPDATE SET
       client_name = excluded.client_name,
       redirect_uris = excluded.redirect_uris,
       last_seen_at = ${nowExpr(db)}`,
    [c.client_id, c.client_name, JSON.stringify(c.redirect_uris), c.kind],
  );
}

export async function getClient(
  clientId: string,
): Promise<OAuthClient | null> {
  const row = (await getDb().get(
    "SELECT client_id, client_name, redirect_uris, kind FROM oauth_clients WHERE client_id = ?",
    [clientId],
  )) as
    | { client_id: string; client_name: string; redirect_uris: string; kind: "dcr" | "cimd" }
    | undefined;
  if (!row) return null;
  let uris: string[] = [];
  try {
    const parsed = JSON.parse(row.redirect_uris);
    if (Array.isArray(parsed)) uris = parsed.filter((u) => typeof u === "string");
  } catch {
    // A row we can't parse is a row we can't authorize against.
    return null;
  }
  return {
    client_id: row.client_id,
    client_name: row.client_name,
    redirect_uris: uris,
    kind: row.kind,
  };
}

// ─── Authorization codes ──────────────────────────────────────────────────

export interface NewCode {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  resource: string | null;
}

/** Mints a code and returns the plaintext — the only time it exists. */
export async function issueCode(input: NewCode): Promise<string> {
  const code = secret();
  await getDb().run(
    `INSERT INTO oauth_codes
       (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, resource, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      hash(code),
      input.clientId,
      input.userId,
      input.redirectUri,
      input.scope,
      input.codeChallenge,
      input.resource,
      iso(CODE_TTL_SECONDS),
    ],
  );
  return code;
}

export interface ConsumedCode {
  clientId: string;
  userId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  resource: string | null;
}

export type CodeRedeemResult =
  | { ok: true; code: ConsumedCode }
  | { ok: false; reason: "unknown" | "expired" | "mismatch" | "replayed" };

/** `used_at` marker for a code presented again after it was redeemed. */
const REPLAYED = "replayed";

/**
 * Redeem a code exactly once.
 *
 * `verify` (client, redirect, PKCE) runs BEFORE the claim. Someone who only
 * saw the code — in a log or a referer — fails it, so they can neither spend
 * the code nor make the real exchange look like a replay and revoke the grant.
 *
 * A presenter who passes `verify` on a code already redeemed holds the code
 * AND its verifier: that is the leak OAuth 2.1 means, so the whole grant is
 * revoked. An expired code is never claimed, so it can never count as one.
 */
export async function redeemCode(
  code: string,
  verify: (c: ConsumedCode) => boolean,
): Promise<CodeRedeemResult> {
  const db = getDb();
  const h = hash(code);
  const row = (await db.get(
    `SELECT client_id, user_id, redirect_uri, scope, code_challenge, resource, expires_at, used_at
       FROM oauth_codes WHERE code_hash = ?`,
    [h],
  )) as
    | {
        client_id: string;
        user_id: string;
        redirect_uri: string;
        scope: string;
        code_challenge: string;
        resource: string | null;
        expires_at: string;
        used_at: string | null;
      }
    | undefined;
  if (!row) return { ok: false, reason: "unknown" };
  const consumed: ConsumedCode = {
    clientId: row.client_id,
    userId: row.user_id,
    redirectUri: row.redirect_uri,
    scope: row.scope,
    codeChallenge: row.code_challenge,
    resource: row.resource,
  };
  if (!verify(consumed)) return { ok: false, reason: "mismatch" };

  const replayed = async (): Promise<CodeRedeemResult> => {
    await db.run(`UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?`, [REPLAYED, h]);
    await revokeGrant(row.user_id, row.client_id);
    return { ok: false, reason: "replayed" };
  };
  if (row.used_at) return replayed();
  if (expired(row.expires_at)) return { ok: false, reason: "expired" };

  // ATOMIC CLAIM. This UPDATE is the single source of truth for "who got the
  // code": two concurrent exchanges can both pass the reads above, and on
  // Postgres (separate connections) both would otherwise get a token pair.
  const claim = await db.run(
    `UPDATE oauth_codes SET used_at = ${nowExpr(db)}
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
    [h, iso(0)],
  );
  if (claim.changes === 1) return { ok: true, code: consumed };
  // Lost the claim: either it expired in between, or a second presenter with
  // the same verifier won the race — a replay.
  const now = (await db.get("SELECT used_at FROM oauth_codes WHERE code_hash = ?", [h])) as
    | { used_at: string | null }
    | undefined;
  return now?.used_at ? replayed() : { ok: false, reason: "expired" };
}

/**
 * Call after issuing tokens for a redeemed code. A replay that landed between
 * the claim and the token insert revoked the grant before those tokens
 * existed; this catches it and revokes them too.
 */
export async function revokeIfReplayed(code: string, c: ConsumedCode): Promise<void> {
  const row = (await getDb().get("SELECT used_at FROM oauth_codes WHERE code_hash = ?", [
    hash(code),
  ])) as { used_at: string | null } | undefined;
  if (row?.used_at === REPLAYED) await revokeGrant(c.userId, c.clientId);
}

// ─── Tokens ───────────────────────────────────────────────────────────────

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  scope: string;
}

export interface GrantInput {
  userId: string;
  clientId: string;
  clientName: string;
  scope: string;
  resource: string | null;
  /** Only issued when the grant asked for offline_access. */
  withRefresh: boolean;
}

export async function issueTokens(input: GrantInput): Promise<IssuedTokens> {
  const accessToken = secret();
  const refreshToken = input.withRefresh ? secret() : null;
  await getDb().run(
    `INSERT INTO oauth_tokens
       (id, user_id, client_id, client_name, access_token_hash, refresh_token_hash,
        scope, resource, expires_at, refresh_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomBytes(16).toString("hex"),
      input.userId,
      input.clientId,
      input.clientName,
      hash(accessToken),
      refreshToken ? hash(refreshToken) : null,
      input.scope,
      input.resource,
      iso(ACCESS_TTL_SECONDS),
      refreshToken ? iso(REFRESH_TTL_SECONDS) : null,
    ],
  );
  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TTL_SECONDS,
    scope: input.scope,
  };
}

export interface ResolvedToken {
  id: string;
  userId: string;
  clientId: string;
  scope: string;
  resource: string | null;
}

/**
 * Resolve a bearer access token to its grant, or null.
 *
 * Expiry and revocation are checked here rather than by the caller so there is
 * one place that decides a token is usable.
 */
export async function resolveAccessToken(
  token: string,
): Promise<ResolvedToken | null> {
  const row = (await getDb().get(
    // JOIN users: a token outlives nothing — a removed user's token is dead
    // even on a database whose FK predates ON DELETE CASCADE.
    `SELECT t.id, t.user_id, t.client_id, t.scope, t.resource, t.expires_at, t.revoked_at
       FROM oauth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.access_token_hash = ?`,
    [hash(token)],
  )) as
    | {
        id: string;
        user_id: string;
        client_id: string;
        scope: string;
        resource: string | null;
        expires_at: string;
        revoked_at: string | null;
      }
    | undefined;
  if (!row || row.revoked_at || expired(row.expires_at)) return null;
  const db = getDb();
  // last_used_at is for the connected-apps list, not accounting, so it does
  // not need to be exact. Writing it on every resolution would put a write on
  // the hot path of every tool call in a chatty MCP session; once every few
  // minutes carries the same information.
  await db.run(
    `UPDATE oauth_tokens SET last_used_at = ${nowExpr(db)}
      WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
    [row.id, sqlTime(-LAST_USED_THROTTLE_MINUTES * 60)],
  );
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    scope: row.scope,
    resource: row.resource,
  };
}

export type RefreshResult =
  | { ok: true; tokens: IssuedTokens }
  | { ok: false; reason: "invalid" };

/**
 * Exchange a refresh token for a new pair, rotating it.
 *
 * OAuth 2.1 requires refresh-token rotation for public clients, which both
 * CIMD and DCR make us. The old row is revoked in the same step that issues
 * the new one, so the replaced token stops working immediately — returning a
 * new refresh token while leaving the old one valid is the failure mode the
 * rotation requirement exists to prevent.
 */
export async function rotateRefreshToken(
  token: string,
  clientId: string,
): Promise<RefreshResult> {
  const db = getDb();
  const h = hash(token);

  // Same atomic claim as consumeCode, for the same reason: revoking the old
  // row IS the act of taking it, so two concurrent refreshes cannot both be
  // served. The client_id is part of the claim so another client cannot
  // redeem a token that was not issued to it.
  const claim = await db.run(
    `UPDATE oauth_tokens SET revoked_at = ${nowExpr(db)}
      WHERE refresh_token_hash = ? AND revoked_at IS NULL AND client_id = ?`,
    [h, clientId],
  );
  if (claim.changes !== 1) {
    // A refresh token that was already rotated (or revoked) and is presented
    // again by its own client has leaked. OAuth 2.1 §4.3.1: revoke the grant.
    const old = (await db.get(
      "SELECT user_id, client_id, revoked_at FROM oauth_tokens WHERE refresh_token_hash = ?",
      [h],
    )) as { user_id: string; client_id: string; revoked_at: string | null } | undefined;
    if (old?.revoked_at && old.client_id === clientId)
      await revokeGrant(old.user_id, old.client_id);
    return { ok: false, reason: "invalid" };
  }

  const row = (await db.get(
    `SELECT user_id, client_id, client_name, scope, resource, refresh_expires_at
       FROM oauth_tokens WHERE refresh_token_hash = ?`,
    [h],
  )) as
    | {
        user_id: string;
        client_id: string;
        client_name: string;
        scope: string;
        resource: string | null;
        refresh_expires_at: string | null;
      }
    | undefined;

  // Expired refreshes leave the row revoked, which is the right end state.
  if (!row || expired(row.refresh_expires_at))
    return { ok: false, reason: "invalid" };

  const tokens = await issueTokens({
    userId: row.user_id,
    clientId: row.client_id,
    clientName: row.client_name,
    scope: row.scope,
    resource: row.resource,
    withRefresh: true,
  });
  return { ok: true, tokens };
}

/** Revoke by either token value. Idempotent, and silent about what it found. */
export async function revokeByToken(token: string): Promise<void> {
  const db = getDb();
  await db.run(
    `UPDATE oauth_tokens SET revoked_at = ${nowExpr(db)}
      WHERE revoked_at IS NULL
        AND (access_token_hash = ? OR refresh_token_hash = ?)`,
    [hash(token), hash(token)],
  );
}

/** Revoke every live grant a user holds for one client — the "disconnect" action. */
export async function revokeGrant(
  userId: string,
  clientId: string,
): Promise<void> {
  const db = getDb();
  await db.run(
    `UPDATE oauth_tokens SET revoked_at = ${nowExpr(db)}
      WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL`,
    [userId, clientId],
  );
}

/**
 * Delete codes and tokens that can never be used again. Used codes are kept a
 * day past expiry so a late replay is still detected and revokes the grant.
 */
export async function purgeExpired(): Promise<void> {
  const db = getDb();
  const now = iso(0);
  await db.run("DELETE FROM oauth_codes WHERE expires_at < ?", [iso(-86400)]);
  await db.run(
    `DELETE FROM oauth_tokens
      WHERE COALESCE(refresh_expires_at, expires_at) < ?
         OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
    [now, sqlTime(-86400)],
  );
  // Registration is open, so clients that never connected (or whose tokens
  // are all gone) would pile up. A client removed here re-registers.
  await db.run(
    `DELETE FROM oauth_clients
      WHERE created_at < ?
        AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = oauth_clients.client_id)
        AND NOT EXISTS (SELECT 1 FROM oauth_codes k WHERE k.client_id = oauth_clients.client_id)`,
    [sqlTime(-CLIENT_IDLE_DAYS * 86400)],
  );
}

/** Revoke every live grant a user holds — on password change, reset or removal. */
export async function revokeAllForUser(userId: string): Promise<void> {
  const db = getDb();
  await db.run(
    `UPDATE oauth_tokens SET revoked_at = ${nowExpr(db)}
      WHERE user_id = ? AND revoked_at IS NULL`,
    [userId],
  );
}

export interface ConnectedApp {
  clientId: string;
  clientName: string;
  scope: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** What the user sees under "connected apps". Live grants only. */
export async function listConnectedApps(
  userId: string,
): Promise<ConnectedApp[]> {
  const rows = (await getDb().all(
    `SELECT client_id, client_name, scope,
            MIN(created_at) AS created_at,
            MAX(last_used_at) AS last_used_at
       FROM oauth_tokens
      WHERE user_id = ? AND revoked_at IS NULL
      GROUP BY client_id, client_name, scope
      ORDER BY created_at DESC`,
    [userId],
  )) as Array<{
    client_id: string;
    client_name: string;
    scope: string;
    created_at: string;
    last_used_at: string | null;
  }>;
  return rows.map((r) => ({
    clientId: r.client_id,
    clientName: r.client_name,
    scope: r.scope,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}
