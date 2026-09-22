/**
 * Storage for the MCP OAuth authorization server: clients, authorization
 * codes, and the access/refresh token pairs they become.
 *
 * SECRET HANDLING. Every credential here is 256 bits from `randomBytes` and is
 * stored as a plain SHA-256 hash, never in the clear — the same discipline
 * `api_keys` uses (`src/auth/keys.ts`). A slow KDF buys nothing against a
 * value with that much entropy; what matters is that a database dump contains
 * no usable token, and that lookups compare in constant time.
 *
 * SINGLE USE. An authorization code is consumed by stamping `used_at` rather
 * than by deletion, so a replay is *detectable*: seeing an already-used code
 * means the code leaked, and OAuth 2.1 requires us to treat that as a
 * compromise of the whole grant, not merely to refuse the second exchange.
 */
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { getDb } from "../db/client.js";

/** Access tokens are short by design; a leaked one should expire quickly. */
export const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
/** Long enough that a connector keeps working without re-consent. */
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days
/** An authorization code should be redeemed within seconds, not minutes. */
export const CODE_TTL_SECONDS = 60;

function secret(): string {
  return randomBytes(32).toString("hex");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time compare of two hex digests of equal length. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function iso(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
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
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(client_id) DO UPDATE SET
       client_name = excluded.client_name,
       redirect_uris = excluded.redirect_uris,
       last_seen_at = datetime('now')`,
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

export type CodeConsumeResult =
  | { ok: true; code: ConsumedCode }
  | { ok: false; reason: "unknown" | "expired" | "replayed" };

/**
 * Consume a code exactly once.
 *
 * A code presented twice is reported as `replayed` rather than `unknown`, so
 * the caller can revoke the whole grant: a second presentation means the code
 * was observed by someone, and OAuth 2.1 treats that as a compromise.
 */
export async function consumeCode(code: string): Promise<CodeConsumeResult> {
  const db = getDb();
  const row = (await db.get(
    `SELECT client_id, user_id, redirect_uri, scope, code_challenge, resource, expires_at, used_at
       FROM oauth_codes WHERE code_hash = ?`,
    [hash(code)],
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
  if (row.used_at) return { ok: false, reason: "replayed" };
  if (expired(row.expires_at)) return { ok: false, reason: "expired" };

  await db.run(
    "UPDATE oauth_codes SET used_at = datetime('now') WHERE code_hash = ? AND used_at IS NULL",
    [hash(code)],
  );
  return {
    ok: true,
    code: {
      clientId: row.client_id,
      userId: row.user_id,
      redirectUri: row.redirect_uri,
      scope: row.scope,
      codeChallenge: row.code_challenge,
      resource: row.resource,
    },
  };
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
    `SELECT id, user_id, client_id, scope, resource, expires_at, revoked_at
       FROM oauth_tokens WHERE access_token_hash = ?`,
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
  await getDb().run(
    "UPDATE oauth_tokens SET last_used_at = datetime('now') WHERE id = ?",
    [row.id],
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
  const row = (await db.get(
    `SELECT id, user_id, client_id, client_name, scope, resource,
            refresh_expires_at, revoked_at
       FROM oauth_tokens WHERE refresh_token_hash = ?`,
    [hash(token)],
  )) as
    | {
        id: string;
        user_id: string;
        client_id: string;
        client_name: string;
        scope: string;
        resource: string | null;
        refresh_expires_at: string | null;
        revoked_at: string | null;
      }
    | undefined;

  // One indistinguishable answer for every failure: unknown token, revoked
  // grant, expired refresh, or a client trying to redeem another's token.
  if (
    !row ||
    row.revoked_at ||
    expired(row.refresh_expires_at) ||
    row.client_id !== clientId
  ) {
    return { ok: false, reason: "invalid" };
  }

  await db.run(
    "UPDATE oauth_tokens SET revoked_at = datetime('now') WHERE id = ?",
    [row.id],
  );
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
  await getDb().run(
    `UPDATE oauth_tokens SET revoked_at = datetime('now')
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
  await getDb().run(
    `UPDATE oauth_tokens SET revoked_at = datetime('now')
      WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL`,
    [userId, clientId],
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

/**
 * A replayed authorization code means the code leaked. OAuth 2.1 says to treat
 * that as a compromise of the grant it produced, so every token descended from
 * it goes too — not just a refusal of the second exchange.
 */
export async function revokeAllForUserClient(
  userId: string,
  clientId: string,
): Promise<void> {
  await revokeGrant(userId, clientId);
}
