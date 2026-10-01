/**
 * Generic OIDC single sign-on — authorization-code flow with PKCE.
 *
 * Works with any spec-compliant IdP; Microsoft Entra ID and Google are the
 * first-class presets in the Settings UI. Superadmin-configurable at runtime
 * (OIDC_* settings via /admin/settings) and entirely separate from the
 * PromptOwl-ticket flow at GET /auth/sso (src/auth/sso-token.ts) — do not
 * conflate the two.
 *
 * Flow:
 *   GET /auth/oidc/login     → discover the issuer, mint state + nonce + PKCE
 *                              verifier into short-lived httpOnly cookies,
 *                              redirect to the IdP's authorization endpoint.
 *   GET /auth/oidc/callback  → verify state, exchange the code (client secret
 *                              + PKCE verifier), validate the ID token against
 *                              the issuer's JWKS (issuer, audience, nonce,
 *                              expiry via jose), enforce the domain allowlist,
 *                              look up / JIT-provision the user, then start a
 *                              browser session exactly like a password login.
 *
 * Every failure redirects to "/?sso_error=<code>" so the SPA surfaces a
 * friendly toast and falls back to the normal sign-in options.
 */
import { Hono } from "hono";
import { createHash, randomBytes } from "crypto";
import { v4 as uuid } from "uuid";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getDb } from "../db/client.js";
import { config, isEmailish } from "../config.js";
import { normalizeEmail } from "../shared/email.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { tryConsume } from "../shared/rate-limit.js";
import { clientIp } from "../shared/request-ip.js";
import { trackEvent } from "../telemetry/tracker.js";
import { hashPassword } from "./keys.js";
import {
  buildClearSessionCookie,
  buildOidcMarkerCookie,
  buildSessionCookie,
  createSession,
  deleteSession,
  getSessionIdFromRequest,
  isSecureRequest,
} from "./sessions.js";
import type { AuthEnv } from "./middleware.js";

// Same window the other anonymous auth entry points use (see DEVICE_LIMIT in
// routes.ts) — both endpoints are unauthenticated and hit the network/DB.
// Buckets are split per endpoint (oidc-login:/oidc-cb:), matching the
// per-endpoint convention in routes.ts, so one full sign-in burns a single
// slot in each bucket rather than two in a shared one.
//
// The cap is deliberately far looser than the credential endpoints': the key
// is the client IP, and an SSO tenant is an office behind ONE NAT egress IP —
// a 10/15min cap would lock out the 11th colleague signing in on a Monday
// morning. There is no secret to guess here (no password, no token), so this
// bucket exists only to stop a flood of discovery/token round-trips to the
// IdP; replay and CSRF are already blocked by state + nonce + PKCE, and the
// IdP enforces its own per-account limits behind us.
const OIDC_LIMIT = { max: 100, windowMs: 15 * 60_000 }; // 100 / 15 min

// Hard ceiling on outbound IdP calls (discovery, token exchange) so a hung
// provider can't pin request handlers. Aborts surface as the same
// discovery_failed / exchange_failed codes as any other IdP fault.
const IDP_FETCH_TIMEOUT_MS = 10_000;

// Flow cookies — short-lived carriers for the state/nonce/PKCE trio between
// /login and /callback. httpOnly (JS never needs them), SameSite=Lax (the
// callback is a top-level redirect from the IdP, which Lax allows), and
// path-scoped to /auth/oidc so they never ride any other request.
const STATE_COOKIE = "cnst_oidc_state";
const NONCE_COOKIE = "cnst_oidc_nonce";
const VERIFIER_COOKIE = "cnst_oidc_verifier";
const FLOW_COOKIE_TTL_SECS = 10 * 60; // 10 minutes

export interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  // Optional (OIDC RP-initiated logout, and not all IdPs advertise it —
  // Google notably omits it). Present → GET /auth/oidc/logout can bounce the
  // browser through the IdP so its session ends too; absent → local-only.
  end_session_endpoint?: string;
}

// In-module discovery cache with a short TTL — one metadata fetch per window
// instead of per sign-in. The remote JWK set rides along (jose caches keys
// internally too and re-fetches on unknown-kid). Keyed by issuer so a runtime
// settings change invalidates naturally.
//
// One entry PER issuer, not one entry total: OIDC login, Entra token-exchange
// and Google token-exchange all call discover() with different issuers, and a
// single slot would evict on every alternating request — refetching metadata
// AND building a fresh createRemoteJWKSet, which throws away jose's key cache
// and its rate-limit cooldown, i.e. a live JWKS fetch per token verified.
// Bounded by design: issuers come from config, never from request input.
const DISCOVERY_TTL_MS = 5 * 60_000;
const discoveryCache = new Map<
  string,
  {
    doc: DiscoveryDoc;
    jwks: ReturnType<typeof createRemoteJWKSet>;
    fetchedAt: number;
  }
>();

/** Enabled AND fully configured — the only state the login button is live. */
export function isOidcReady(): boolean {
  return (
    config.OIDC_ENABLED &&
    !!config.OIDC_ISSUER &&
    !!config.OIDC_CLIENT_ID &&
    !!config.OIDC_CLIENT_SECRET
  );
}

export async function discover(issuer: string): Promise<{
  doc: DiscoveryDoc;
  jwks: ReturnType<typeof createRemoteJWKSet>;
}> {
  const now = Date.now();
  const cached = discoveryCache.get(issuer);
  if (cached && now - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return { doc: cached.doc, jwks: cached.jwks };
  }

  const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(IDP_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`discovery fetch failed with status ${res.status}`);
  }
  const doc = (await res.json()) as Partial<DiscoveryDoc>;
  if (
    !doc.issuer ||
    !doc.authorization_endpoint ||
    !doc.token_endpoint ||
    !doc.jwks_uri
  ) {
    throw new Error("discovery document is missing required fields");
  }
  // Issuer-mix-up guard: the document must describe the issuer we asked for.
  // (Trailing-slash differences are tolerated; nothing else is.)
  if (doc.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) {
    throw new Error(
      `discovery issuer mismatch: expected ${issuer}, got ${doc.issuer}`,
    );
  }
  const jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
  discoveryCache.set(issuer, { doc: doc as DiscoveryDoc, jwks, fetchedAt: now });
  return { doc: doc as DiscoveryDoc, jwks };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** RFC 7636 S256: challenge = BASE64URL(SHA256(verifier)). */
function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// Defensive cap on the stored department — it's directory metadata that later
// becomes a tag slug, so anything longer is junk (or an abusive claim).
const DEPARTMENT_MAX_LENGTH = 120;

/**
 * Normalize the optional `department` ID-token claim: string → trimmed, inner
 * whitespace collapsed, length-capped; anything else (absent, non-string,
 * whitespace-only) → null. Null is meaningful — the login upsert writes it
 * through, so a claim the IdP stopped emitting CLEARS users.department.
 */
export function normalizeDepartment(claim: unknown): string | null {
  if (typeof claim !== "string") return null;
  const collapsed = claim.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, DEPARTMENT_MAX_LENGTH).trim();
}

function buildFlowCookie(
  name: string,
  value: string,
  opts: { secure: boolean; clear?: boolean },
): string {
  const parts = [
    `${name}=${value}`,
    "HttpOnly",
    "Path=/auth/oidc",
    "SameSite=Lax",
    `Max-Age=${opts.clear ? 0 : FLOW_COOKIE_TTL_SECS}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Parse one cookie by name out of the request's Cookie header. */
function readCookie(c: any, name: string): string | null {
  const header = c.req.header("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) {
      const v = rest.join("=").trim();
      // Values we set are opaque base64url — reject anything else so a forged
      // cookie can't smuggle unexpected characters into comparisons/params.
      return /^[A-Za-z0-9_-]{16,256}$/.test(v) ? v : null;
    }
  }
  return null;
}

/** This server's OIDC redirect URI — what the admin registers at the IdP. */
export function oidcRedirectUri(reqUrl: string): string {
  return `${requestBaseUrl(reqUrl)}/auth/oidc/callback`;
}

export const oidcRoutes = new Hono<AuthEnv>();

// GET /auth/oidc/login — start the flow: redirect the browser to the IdP.
oidcRoutes.get("/login", async (c) => {
  const bounce = (code: string) => c.redirect(`/?sso_error=${code}`, 302);

  if (!config.OIDC_ENABLED) return bounce("disabled");
  if (!isOidcReady()) return bounce("not_configured");
  if (!tryConsume(`oidc-login:ip:${clientIp(c)}`, OIDC_LIMIT)) {
    return bounce("rate_limited");
  }

  let doc: DiscoveryDoc;
  try {
    ({ doc } = await discover(config.OIDC_ISSUER));
  } catch (err) {
    console.error("[oidc] discovery failed:", err);
    return bounce("discovery_failed");
  }

  // Fresh CSRF/replay material per attempt. state links callback→this
  // browser; nonce binds the ID token to this flow; the PKCE verifier proves
  // to the token endpoint that the code redeemer started the flow.
  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(32));

  const secure = isSecureRequest(c);
  c.header("Set-Cookie", buildFlowCookie(STATE_COOKIE, state, { secure }), {
    append: true,
  });
  c.header("Set-Cookie", buildFlowCookie(NONCE_COOKIE, nonce, { secure }), {
    append: true,
  });
  c.header(
    "Set-Cookie",
    buildFlowCookie(VERIFIER_COOKIE, verifier, { secure }),
    { append: true },
  );

  const authorizeUrl = new URL(doc.authorization_endpoint);
  authorizeUrl.searchParams.set("client_id", config.OIDC_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", oidcRedirectUri(c.req.url));
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid email profile");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("nonce", nonce);
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return c.redirect(authorizeUrl.toString(), 302);
});

// GET /auth/oidc/callback — finish the flow: code → tokens → session.
oidcRoutes.get("/callback", async (c) => {
  const secure = isSecureRequest(c);
  // The flow cookies are single-use — clear them on EVERY outcome so a
  // replayed callback URL can't be retried against stale material.
  const clearFlowCookies = () => {
    for (const name of [STATE_COOKIE, NONCE_COOKIE, VERIFIER_COOKIE]) {
      c.header("Set-Cookie", buildFlowCookie(name, "", { secure, clear: true }), {
        append: true,
      });
    }
  };
  const bounce = (code: string) => {
    clearFlowCookies();
    return c.redirect(`/?sso_error=${code}`, 302);
  };

  if (!config.OIDC_ENABLED) return bounce("disabled");
  if (!isOidcReady()) return bounce("not_configured");
  if (!tryConsume(`oidc-cb:ip:${clientIp(c)}`, OIDC_LIMIT)) {
    return bounce("rate_limited");
  }

  // IdP-side refusal (user cancelled consent, tenant policy, ...) comes back
  // as ?error=<code> instead of ?code=.
  if (c.req.query("error")) return bounce("provider_error");

  // CSRF check FIRST: the state in the URL must match the cookie this browser
  // minted at /login. Either side missing is the same failure.
  const stateParam = c.req.query("state") || "";
  const stateCookie = readCookie(c, STATE_COOKIE);
  if (!stateCookie || !stateParam || stateParam !== stateCookie) {
    return bounce("state_mismatch");
  }

  const code = c.req.query("code");
  if (!code) return bounce("exchange_failed");
  const nonceCookie = readCookie(c, NONCE_COOKIE);
  const verifierCookie = readCookie(c, VERIFIER_COOKIE);
  if (!nonceCookie || !verifierCookie) return bounce("state_mismatch");

  let doc: DiscoveryDoc;
  let jwks: ReturnType<typeof createRemoteJWKSet>;
  try {
    ({ doc, jwks } = await discover(config.OIDC_ISSUER));
  } catch (err) {
    console.error("[oidc] discovery failed:", err);
    return bounce("discovery_failed");
  }

  // ── Code exchange (confidential client + PKCE) ─────────────────────────
  // Client authentication is client_secret_post (secret in the body). Every
  // shipped preset — Entra v2, Google, Okta, Keycloak — accepts it. An IdP
  // configured to REQUIRE client_secret_basic (secret in an Authorization:
  // Basic header) is unsupported for now; add discovery-driven negotiation
  // (token_endpoint_auth_methods_supported) if a real client needs it.
  let idToken: string;
  try {
    const tokenRes = await fetch(doc.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: oidcRedirectUri(c.req.url),
        client_id: config.OIDC_CLIENT_ID,
        client_secret: config.OIDC_CLIENT_SECRET,
        code_verifier: verifierCookie,
      }).toString(),
      signal: AbortSignal.timeout(IDP_FETCH_TIMEOUT_MS),
    });
    if (!tokenRes.ok) {
      console.error(
        `[oidc] token exchange failed with status ${tokenRes.status}`,
      );
      return bounce("exchange_failed");
    }
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token || typeof tokens.id_token !== "string") {
      return bounce("exchange_failed");
    }
    idToken = tokens.id_token;
  } catch (err) {
    console.error("[oidc] token exchange failed:", err);
    return bounce("exchange_failed");
  }

  // ── ID-token validation ────────────────────────────────────────────────
  // jose verifies signature (against the issuer's JWKS), iss, aud, exp/nbf.
  // The nonce claim is checked manually against the flow cookie — it's what
  // binds this token to the flow THIS browser started.
  let claims: Record<string, unknown>;
  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: doc.issuer,
      audience: config.OIDC_CLIENT_ID,
      // Explicit allowlist on top of the JWKS constraint. createRemoteJWKSet
      // already refuses keys the issuer doesn't publish, so alg-confusion is
      // blocked either way; this pins the header alg so a JWKS that ever
      // starts publishing an unexpected key type can't shift us onto it.
      // RS256 is what every supported preset emits (Entra v2, Google, Okta,
      // Keycloak default) and is the OIDC-mandated baseline.
      algorithms: ["RS256"],
    });
    claims = payload as Record<string, unknown>;
  } catch (err) {
    console.error("[oidc] ID token validation failed:", err);
    return bounce("invalid_token");
  }
  if (claims.nonce !== nonceCookie) return bounce("invalid_token");

  // email_verified policy: an EXPLICIT false is refused — on permissive IdPs
  // (e.g. a default Keycloak realm with open self-registration) an attacker
  // can self-register with an existing local user's address and would
  // otherwise sign straight into that account. An ABSENT claim is allowed:
  // Entra v2 tokens frequently omit it and Entra/Google both guarantee
  // address ownership — refusing on absence would break the primary IdPs.
  // The trust assumption for the absent case is documented in
  // CONFIGURATION.md → Single sign-on (OIDC).
  //
  // The string "false" counts as false: the claim is a boolean per spec, but
  // non-compliant IdPs do emit it stringified, and reading that as "absent"
  // would silently flip a refusal into a trust.
  if (claims.email_verified === false || claims.email_verified === "false") {
    return bounce("email_not_verified");
  }

  // Email: standard `email` claim; Entra ID often omits it and carries the
  // UPN in `preferred_username` instead. Normalize like the register path
  // (trim + lowercase) and require a real address shape either way.
  const rawEmail =
    (typeof claims.email === "string" && claims.email) ||
    (typeof claims.preferred_username === "string" &&
      claims.preferred_username) ||
    "";
  const email = normalizeEmail(rawEmail);
  if (!email || !isEmailish(email)) return bounce("invalid_token");

  // Domain allowlist — empty list = any domain.
  const allowed = config.OIDC_ALLOWED_DOMAINS;
  if (allowed.length > 0) {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (!allowed.includes(domain)) return bounce("domain_not_allowed");
  }

  const name =
    typeof claims.name === "string" && claims.name.trim()
      ? claims.name.trim()
      : null;

  // Directory department (optional `department` claim — Entra emits it as an
  // ID-token optional claim; see CONFIGURATION.md). Upserted on EVERY login:
  // present → users.department takes the claim's value, absent/non-string →
  // NULL, so a removed claim clears the stored value and directory moves
  // propagate on the next sign-in. Whitespace is trimmed + collapsed and the
  // value is capped defensively — it later becomes a tag slug, never markup.
  const department = normalizeDepartment(claims.department);

  // ── Look up / JIT-provision, then session — like the password path ─────
  try {
    const db = getDb();
    let user = (await db.get(
      "SELECT id, email, name, is_service FROM users WHERE LOWER(email) = ?",
      [email],
    )) as { id: string; email: string; name: string | null; is_service?: number | null } | undefined;
    // An access key's identity (CU-wdqcq0314u) is not an account anyone signs
    // in as. Its .invalid address can't come from a real IdP; this makes the
    // refusal explicit rather than relying on that (createSession refuses too).
    if (user?.is_service) return bounce("not_invited");

    if (!user) {
      if (!config.OIDC_AUTO_PROVISION) return bounce("not_invited");
      // Mirror the register/invite creation shape: random placeholder
      // password hash (the user signs in via the IdP; password login stays
      // possible only after an admin reset).
      const userId = uuid();
      const placeholderHash = await hashPassword(uuid());
      try {
        await db.run(
          "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
          [userId, email, name, placeholderHash],
        );
        user = { id: userId, email, name };
        trackEvent("user.register", { userId, email, method: "oidc" });
      } catch (insErr) {
        // Two callbacks for the same brand-new email can race: the unique
        // index on users.email rejects the loser's INSERT. That's not a
        // failure — the row now exists — so re-read and sign them in rather
        // than bouncing service_error. Any OTHER error is a real fault.
        const raced = (await db.get(
          "SELECT id, email, name FROM users WHERE LOWER(email) = ?",
          [email],
        )) as { id: string; email: string; name: string | null } | undefined;
        if (!raced) throw insErr;
        user = raced;
        trackEvent("user.login", { userId: user.id, method: "oidc" });
      }
    } else {
      trackEvent("user.login", { userId: user.id, method: "oidc" });
    }

    // Department upsert — every login (existing, JIT, or raced) syncs
    // users.department to this token's claim. `department` is already null
    // when the claim is absent, so the write-through both sets and clears.
    // Best-effort by design (own try/catch, NOT the enclosing one): this is
    // ancillary directory metadata, and a transient failure here must degrade
    // to "department not captured this login" — never bounce a valid sign-in
    // to service_error. Same never-block philosophy as departmentTagFor in
    // src/nodes/service.ts, which already treats a missing value as a no-op.
    try {
      await db.run("UPDATE users SET department = ? WHERE id = ?", [
        department,
        user.id,
      ]);
    } catch (err) {
      console.error("[oidc] department upsert failed (login continues):", err);
    }

    // Same session mechanics as a successful password login: sessions-table
    // row + httpOnly cookie (Secure on HTTPS), then land on the app. Plus the
    // non-secret SSO marker so the SPA routes logout through the IdP.
    const sessionId = await createSession(user.id, c.req.header("User-Agent"));
    clearFlowCookies();
    c.header("Set-Cookie", buildSessionCookie(sessionId, { secure }), {
      append: true,
    });
    c.header("Set-Cookie", buildOidcMarkerCookie({ secure }), { append: true });
    return c.redirect("/", 302);
  } catch (err) {
    console.error("[oidc] provisioning/session failed:", err);
    return bounce("service_error");
  }
});

// GET /auth/oidc/logout — RP-initiated logout. Tear down the local session
// (same as POST /auth/logout), then, if the IdP advertises an
// end_session_endpoint, bounce the browser through it so the IdP session ends
// too — otherwise a "sign out" leaves the IdP logged in and the next SSO
// click silently re-authenticates. Only SSO sessions reach here: the SPA
// routes to this URL solely when the cnst_sso_session marker is set.
//
// Always clears cookies and always lands the user back on "/", even if
// discovery is down or the IdP has no logout endpoint (Google) — logout must
// never leave the user stuck signed-in locally because the IdP was
// unreachable.
oidcRoutes.get("/logout", async (c) => {
  const secure = isSecureRequest(c);
  const sessionId = getSessionIdFromRequest(c);
  if (sessionId) {
    try {
      await deleteSession(sessionId);
    } catch (err) {
      console.error("[oidc] logout: failed to delete session:", err);
    }
  }
  c.header("Set-Cookie", buildClearSessionCookie({ secure }), { append: true });
  c.header("Set-Cookie", buildOidcMarkerCookie({ secure, clear: true }), {
    append: true,
  });

  const home = `${requestBaseUrl(c.req.url)}/`;
  if (isOidcReady()) {
    try {
      const { doc } = await discover(config.OIDC_ISSUER);
      if (doc.end_session_endpoint) {
        const url = new URL(doc.end_session_endpoint);
        url.searchParams.set("post_logout_redirect_uri", home);
        url.searchParams.set("client_id", config.OIDC_CLIENT_ID);
        return c.redirect(url.toString(), 302);
      }
    } catch (err) {
      // Discovery down → fall through to a clean local logout.
      console.error("[oidc] logout: discovery failed, local-only:", err);
    }
  }
  return c.redirect(home, 302);
});
