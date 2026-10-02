/**
 * OAuth "Connect" for plugins — the host side of `manifest.oauth`.
 *
 * A plugin that needs a PERSON's consent (their Drive, their Teams chats)
 * declares a provider + scopes. This module:
 *
 *   1. starts the consent flow: a single-use state row (nest, plugin, user,
 *      PKCE verifier, 10-minute expiry) and a 302 to the provider;
 *   2. finishes it on the callback: verifies the state, exchanges the code
 *      with PKCE, stores the refresh token WRITE-ONLY in nest_env
 *      (`PLUGIN__<NAME>__REFRESH_TOKEN`) plus who connected and when;
 *   3. hands every run a fresh access token — refreshed from the stored
 *      refresh token and cached per process until shortly before expiry —
 *      as `settings.accessToken`. The plugin never sees the refresh token.
 *
 * OAuth clients are server-wide: `OAUTH_GOOGLE_CLIENT_ID/SECRET`,
 * `OAUTH_MICROSOFT_CLIENT_ID/SECRET(/TENANT)`, and for a plugin's own
 * (custom) provider `PLUGIN_OAUTH_<NAME>_CLIENT_ID/SECRET`. The redirect
 * URI is always `<PUBLIC_BASE_URL>/auth/plugins/callback`.
 */
import { createHash, randomBytes } from "node:crypto";
import type { NestPlugin, OAuthDeclaration } from "@promptowl/contextnest-plugin-sdk";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { ConflictError, ValidationError } from "../shared/errors.js";
import { envKeyFor, readSecrets, putSecrets } from "./registry.js";

export const REFRESH_TOKEN_KEY = "oauthRefreshToken";
export const OAUTH_META_KEY = "oauthMeta";
const STATE_TTL_MS = 10 * 60_000;

interface ProviderConfig { authorizationUrl: string; tokenUrl: string; clientId: string; clientSecret: string; extraAuthParams: Record<string, string> }

const KNOWN: Record<string, (tenant: string) => { authorizationUrl: string; tokenUrl: string; extraAuthParams: Record<string, string> }> = {
  // include_granted_scopes is deliberately ABSENT: with incremental
  // authorization Google folds every product's grant into one, and its revoke
  // endpoint kills the whole grant — disconnecting Drive would silently
  // disconnect Gmail on the same account. Each plugin keeps its own grant so
  // disconnecting one severs only its own scopes.
  google: () => ({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", extraAuthParams: { access_type: "offline", prompt: "consent" } }),
  microsoft: (tenant) => ({ authorizationUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`, tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, extraAuthParams: { response_mode: "query", prompt: "select_account" } }),
};

const envName = (plugin: string, key: string) => `PLUGIN_OAUTH_${plugin.toUpperCase().replace(/-/g, "_")}_${key}`;

/** The provider endpoints + client for a plugin's declaration, or a 409 naming what the admin must set. */
export function providerFor(plugin: NestPlugin): ProviderConfig {
  const o = plugin.manifest.oauth;
  if (!o) throw new ValidationError(`Plugin "${plugin.manifest.name}" does not use OAuth`);
  let clientId: string | undefined, clientSecret: string | undefined, idName: string, secretName: string;
  if (o.provider === "google") { idName = "OAUTH_GOOGLE_CLIENT_ID"; secretName = "OAUTH_GOOGLE_CLIENT_SECRET"; }
  else if (o.provider === "microsoft") { idName = "OAUTH_MICROSOFT_CLIENT_ID"; secretName = "OAUTH_MICROSOFT_CLIENT_SECRET"; }
  else { idName = envName(plugin.manifest.name, "CLIENT_ID"); secretName = envName(plugin.manifest.name, "CLIENT_SECRET"); }
  clientId = process.env[idName]; clientSecret = process.env[secretName];
  if (!clientId || !clientSecret) throw new ConflictError(`${plugin.manifest.displayName} needs an OAuth client on this server — a server admin must set ${idName} and ${secretName} (Settings → Plugins).`);
  const known = KNOWN[o.provider]?.(process.env.OAUTH_MICROSOFT_TENANT || "common");
  const authorizationUrl = o.authorizationUrl ?? known?.authorizationUrl;
  const tokenUrl = o.tokenUrl ?? known?.tokenUrl;
  if (!authorizationUrl || !tokenUrl) throw new ValidationError(`Plugin "${plugin.manifest.name}" declares a custom OAuth provider without endpoints`);
  for (const u of [authorizationUrl, tokenUrl]) if (!/^https:\/\//.test(u) && process.env.OAUTH_ALLOW_INSECURE !== "true") throw new ValidationError(`OAuth endpoints must be https: ${u}`);
  return { authorizationUrl, tokenUrl, clientId, clientSecret, extraAuthParams: { ...(known?.extraAuthParams ?? {}), ...(o.extraAuthParams ?? {}) } };
}

export function redirectUri(): string {
  if (!config.PUBLIC_BASE_URL) throw new ConflictError("PUBLIC_BASE_URL must be set for OAuth connections — the provider needs a stable callback URL");
  return `${config.PUBLIC_BASE_URL}/auth/plugins/callback`;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Start: record a single-use state and build the consent URL. */
export async function beginConnect(nestId: string, plugin: NestPlugin, userId: string, userEmail: string): Promise<string> {
  const p = providerFor(plugin);
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const now = Date.now();
  const db = getDb();
  await db.run("DELETE FROM plugin_oauth_states WHERE expires_at < ?", [new Date(now).toISOString()]);
  await db.run("INSERT INTO plugin_oauth_states (state, nest_id, plugin, user_id, user_email, verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    state, nestId, plugin.manifest.name, userId, userEmail, verifier, new Date(now).toISOString(), new Date(now + STATE_TTL_MS).toISOString(),
  ]);
  const u = new URL(p.authorizationUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("scope", plugin.manifest.oauth!.scopes.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
  u.searchParams.set("code_challenge_method", "S256");
  if (!("access_type" in p.extraAuthParams)) u.searchParams.set("access_type", "offline");
  for (const [k, v] of Object.entries(p.extraAuthParams)) u.searchParams.set(k, v);
  return u.toString();
}

interface StateRow { state: string; nest_id: string; plugin: string; user_id: string; user_email: string; verifier: string; expires_at: string }

/** Consume a state row (single use). Null when unknown or expired. */
export async function consumeState(state: string): Promise<StateRow | null> {
  const db = getDb();
  const row = (await db.get("SELECT * FROM plugin_oauth_states WHERE state = ?", [state])) as StateRow | undefined;
  if (!row) return null;
  await db.run("DELETE FROM plugin_oauth_states WHERE state = ?", [state]);
  return Date.parse(row.expires_at) < Date.now() ? null : row;
}

async function tokenRequest(p: ProviderConfig, params: Record<string, string>): Promise<Record<string, any>> {
  const res = await fetch(p.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ client_id: p.clientId, client_secret: p.clientSecret, ...params }).toString() });
  const text = await res.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* provider returned non-JSON */ }
  if (!res.ok || json.error) throw new Error(json.error_description || json.error || `token endpoint returned HTTP ${res.status}`);
  return json;
}

/** Finish: exchange the code and store the refresh token under the nest. */
export async function completeConnect(row: StateRow, plugin: NestPlugin, code: string): Promise<void> {
  const p = providerFor(plugin);
  const tok = await tokenRequest(p, { grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: row.verifier });
  if (!tok.refresh_token) throw new Error("the provider returned no refresh token — for Google, the app must request offline access and the user must re-consent (prompt=consent)");
  const meta = JSON.stringify({ provider: plugin.manifest.oauth!.provider, scopes: String(tok.scope ?? plugin.manifest.oauth!.scopes.join(" ")), connected_by: row.user_email, connected_at: new Date().toISOString() });
  await putSecrets(row.nest_id, plugin.manifest.name, { [REFRESH_TOKEN_KEY]: String(tok.refresh_token), [OAUTH_META_KEY]: meta }, row.user_email);
  tokenCache.delete(`${row.nest_id}:${plugin.manifest.name}`);
}

export async function disconnect(nestId: string, plugin: NestPlugin, by: string): Promise<void> {
  await putSecrets(nestId, plugin.manifest.name, { [REFRESH_TOKEN_KEY]: "", [OAUTH_META_KEY]: "" }, by);
  tokenCache.delete(`${nestId}:${plugin.manifest.name}`);
}

export async function connectionInfo(nestId: string, plugin: NestPlugin): Promise<{ provider: string; scopes: string[]; connected: boolean; connected_by?: string; connected_at?: string } | null> {
  const o = plugin.manifest.oauth;
  if (!o) return null;
  const s = await readSecrets(nestId, plugin.manifest.name, [REFRESH_TOKEN_KEY, OAUTH_META_KEY]);
  let meta: Record<string, string> = {};
  try { meta = s[OAUTH_META_KEY] ? JSON.parse(s[OAUTH_META_KEY]) : {}; } catch { meta = {}; }
  return { provider: o.provider, scopes: o.scopes, connected: !!s[REFRESH_TOKEN_KEY], ...(meta.connected_by ? { connected_by: meta.connected_by } : {}), ...(meta.connected_at ? { connected_at: meta.connected_at } : {}) };
}

// ─── access tokens ───────────────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
/** Test seam. */
export function invalidateTokenCache(): void { tokenCache.clear(); }

/**
 * A fresh access token for a connected plugin. A refresh the provider
 * refuses (revoked, password changed) clears the stored token so the UI
 * shows "not connected" and the error says to reconnect.
 */
export async function accessTokenFor(nestId: string, plugin: NestPlugin): Promise<string> {
  const key = `${nestId}:${plugin.manifest.name}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const s = await readSecrets(nestId, plugin.manifest.name, [REFRESH_TOKEN_KEY]);
  const refresh = s[REFRESH_TOKEN_KEY];
  if (!refresh) throw new ConflictError(`${plugin.manifest.displayName} is not connected — open the nest's Plugins tab and connect an account`);
  const p = providerFor(plugin);
  let tok: Record<string, any>;
  try {
    tok = await tokenRequest(p, { grant_type: "refresh_token", refresh_token: refresh, scope: plugin.manifest.oauth!.scopes.join(" ") });
  } catch (err) {
    await putSecrets(nestId, plugin.manifest.name, { [REFRESH_TOKEN_KEY]: "" }, "system:oauth");
    tokenCache.delete(key);
    throw new ConflictError(`${plugin.manifest.displayName}: the provider refused the stored token (${(err as Error).message}) — please reconnect the account`);
  }
  // Some providers rotate the refresh token on use; keep the newest.
  if (tok.refresh_token && tok.refresh_token !== refresh) await putSecrets(nestId, plugin.manifest.name, { [REFRESH_TOKEN_KEY]: String(tok.refresh_token) }, "system:oauth");
  const token = String(tok.access_token);
  tokenCache.set(key, { token, expiresAt: Date.now() + Math.max(60, Number(tok.expires_in) || 3600) * 1000 });
  return token;
}

/** Secret setting names the registry must treat as write-only for an OAuth plugin. */
export const OAUTH_SECRET_KEYS = [REFRESH_TOKEN_KEY, OAUTH_META_KEY];
export const oauthEnvKey = (plugin: string) => envKeyFor(plugin, REFRESH_TOKEN_KEY);
