/**
 * SSO token-exchange (RFC 8693-style) — POST /auth/token-exchange.
 *
 * An external agent acting for a user already authenticated by the customer's
 * IdP (Microsoft Entra / Google) presents that IdP's ID token and receives a
 * short-lived, scoped MCP bearer — no second login.
 *
 * SECURITY: this trusts a token minted elsewhere and hands back access, so the
 * verification IS the feature. We verify the inbound subject_token's
 *   • signature — against the provider's JWKS (RS256, alg pinned)
 *   • issuer    — exact per provider (Entra tenant / Google)
 *   • audience  — our configured client id (rejects a token minted for any
 *                 OTHER app → blocks cross-app replay)
 *   • expiry
 * then apply the SAME email_verified + domain-allowlist policy as browser login
 * (the canonical copy lives in oidc.ts's callback — keep the two in sync),
 * resolve/JIT the user, and mint an HS256 "mcp" ticket signed with
 * MCP_SIGNING_SECRET (aud = PUBLIC_BASE_URL, ttl = MCP_TOKEN_TTL_SECONDS).
 *
 * Feature-flagged OFF (SSO_TOKEN_EXCHANGE_ENABLED). Unlike the browser flow
 * there is no session to bind, so nonce-binding is intentionally dropped; trust
 * rests on signature + issuer + audience + expiry + email_verified. This is the
 * standard token-exchange trust model and is documented in CONFIGURATION.md.
 */
import type { Context } from "hono";
import { v4 as uuid } from "uuid";
import { jwtVerify } from "jose";
import { getDb } from "../db/client.js";
import { config, isEmailish } from "../config.js";
import { normalizeEmail } from "../shared/email.js";
import { tryConsume } from "../shared/rate-limit.js";
import { clientIp } from "../shared/request-ip.js";
import { trackEvent } from "../telemetry/tracker.js";
import { hashPassword } from "./keys.js";
import { discover } from "./oidc.js";
import { signMcpTicket } from "./sso-token.js";
import type { AuthEnv } from "./middleware.js";

export type ExchangeProvider = "microsoft" | "google";

// Token-gated endpoint (no secret to brute-force), so the looser OIDC-shaped
// per-IP cap fits — a burst of bad tokens still can't hammer the IdP JWKS.
const TX_LIMIT = { max: 60, windowMs: 15 * 60_000 };

class ExchangeError extends Error {
  constructor(
    public code: string,
    public status: number,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/**
 * The exact issuer we require for a provider's ID token. Pure (unit-tested):
 * Entra v2 is tenant-scoped; Google is fixed. Empty string ⇒ not configured.
 */
export function expectedIssuer(
  provider: ExchangeProvider,
  msTenantId: string,
): string {
  if (provider === "microsoft") {
    return msTenantId
      ? `https://login.microsoftonline.com/${msTenantId}/v2.0`
      : "";
  }
  return "https://accounts.google.com";
}

function providerConfig(p: ExchangeProvider): {
  enabled: boolean;
  issuer: string;
  audience: string;
} {
  if (p === "microsoft") {
    return {
      enabled: config.MS_TOKEN_EXCHANGE_ENABLED,
      issuer: expectedIssuer("microsoft", config.MS_TENANT_ID),
      audience: config.MS_CLIENT_ID,
    };
  }
  return {
    enabled: config.GOOGLE_TOKEN_EXCHANGE_ENABLED,
    issuer: expectedIssuer("google", ""),
    audience: config.GOOGLE_CLIENT_ID,
  };
}

/** Verify an inbound IdP ID token → the verified email + display name. */
async function verifySubjectToken(
  provider: ExchangeProvider,
  subjectToken: string,
): Promise<{ email: string; name: string | null }> {
  const pc = providerConfig(provider);
  if (!pc.issuer || !pc.audience) {
    throw new ExchangeError("provider_misconfigured", 400);
  }

  let claims: Record<string, unknown>;
  try {
    const { doc, jwks } = await discover(pc.issuer);
    const { payload } = await jwtVerify(subjectToken, jwks, {
      issuer: doc.issuer,
      audience: pc.audience,
      algorithms: ["RS256"],
    });
    claims = payload as Record<string, unknown>;
  } catch {
    // Bad signature, wrong issuer/audience, expired, malformed — all one class.
    throw new ExchangeError("invalid_subject_token", 401);
  }

  // email_verified: an EXPLICIT false is refused (mirrors oidc.ts:397); an
  // absent claim is allowed (Entra v2 omits it and guarantees ownership).
  if (claims.email_verified === false || claims.email_verified === "false") {
    throw new ExchangeError("email_not_verified", 403);
  }

  // Entra often omits `email` and carries the address in `preferred_username`.
  const raw =
    (typeof claims.email === "string" && claims.email) ||
    (typeof claims.preferred_username === "string" &&
      claims.preferred_username) ||
    "";
  const email = normalizeEmail(raw);
  if (!email || !isEmailish(email)) {
    throw new ExchangeError("invalid_subject_token", 401);
  }

  const allowed = config.OIDC_ALLOWED_DOMAINS;
  if (
    allowed.length > 0 &&
    !allowed.includes(email.slice(email.lastIndexOf("@") + 1))
  ) {
    throw new ExchangeError("domain_not_allowed", 403);
  }

  const name =
    typeof claims.name === "string" && claims.name.trim()
      ? claims.name.trim()
      : null;
  return { email, name };
}

/** Resolve or JIT-provision the user (mirrors the oidc.ts callback resolve). */
async function resolveUser(
  email: string,
  name: string | null,
): Promise<{ id: string }> {
  const db = getDb();
  const existing = (await db.get(
    "SELECT id FROM users WHERE LOWER(email) = ?",
    [email],
  )) as { id: string } | undefined;
  if (existing) return existing;

  if (!config.OIDC_AUTO_PROVISION) {
    throw new ExchangeError("no_account", 403);
  }
  const userId = uuid();
  const placeholderHash = await hashPassword(uuid());
  try {
    await db.run(
      "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
      [userId, email, name, placeholderHash],
    );
    trackEvent("user.register", { userId, email, method: "token-exchange" });
    return { id: userId };
  } catch (insErr) {
    // Two concurrent exchanges for a brand-new email race on the unique index —
    // the loser re-reads rather than failing.
    const raced = (await db.get(
      "SELECT id FROM users WHERE LOWER(email) = ?",
      [email],
    )) as { id: string } | undefined;
    if (!raced) throw insErr;
    return raced;
  }
}

export async function handleTokenExchange(c: Context<AuthEnv>) {
  // Master flag + a signing secret to mint with. 404 (not 403) so a disabled
  // server doesn't advertise the endpoint's existence.
  if (!config.SSO_TOKEN_EXCHANGE_ENABLED || !config.MCP_SIGNING_SECRET) {
    return c.json(
      { error: "Token exchange is not enabled on this server", code: "disabled" },
      404,
    );
  }
  if (!tryConsume(`token-exchange:${clientIp(c)}`, TX_LIMIT)) {
    return c.json({ error: "Too many requests", code: "rate_limited" }, 429);
  }

  let body: { provider?: string; subject_token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", code: "bad_request" }, 400);
  }

  const provider = body.provider as ExchangeProvider;
  if (provider !== "microsoft" && provider !== "google") {
    return c.json({ error: "Unknown or missing provider", code: "bad_request" }, 400);
  }
  if (!providerConfig(provider).enabled) {
    return c.json({ error: "Provider not enabled", code: "provider_disabled" }, 400);
  }
  const subjectToken = (body.subject_token || "").trim();
  if (!subjectToken) {
    return c.json({ error: "Missing subject_token", code: "bad_request" }, 400);
  }

  try {
    const { email, name } = await verifySubjectToken(provider, subjectToken);
    const user = await resolveUser(email, name);
    const token = signMcpTicket(
      {
        sub: email,
        aud: config.PUBLIC_BASE_URL || undefined,
        name: name ?? undefined,
        ttlSeconds: config.MCP_TOKEN_TTL_SECONDS,
      },
      config.MCP_SIGNING_SECRET,
    );
    trackEvent("token_exchange.mint", { userId: user.id, provider });
    return c.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: config.MCP_TOKEN_TTL_SECONDS,
    });
  } catch (err) {
    if (err instanceof ExchangeError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    console.error("[token-exchange] unexpected error:", err);
    return c.json({ error: "Token exchange failed", code: "server_error" }, 500);
  }
}
