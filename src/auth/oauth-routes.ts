/**
 * The MCP OAuth authorization server: /oauth/register, /oauth/authorize,
 * /oauth/token, /oauth/revoke.
 *
 * Everything here is gated on MCP_OAUTH_ENABLED and 404s while it is off, so
 * the flag genuinely means "this surface does not exist".
 *
 * WHAT THIS BUYS. The server already decides what an MCP caller may read, per
 * user — `buildNestIndex` gates every nest through `canRead(nestId, userId)`.
 * An API key pasted into Claude by four people resolves all four to the same
 * user, so they all see whatever its owner sees. These endpoints are how a
 * person arrives as themselves instead.
 *
 * The consent page is deliberately a self-contained HTML document rather than
 * an SPA route: an authorization page that fails when a JS bundle fails is a
 * bad authorization page, and it keeps this flow independent of the frontend
 * router. Sign-in reuses POST /auth/login over fetch, so no credential logic
 * is duplicated here.
 */
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { resolveSession, getSessionIdFromRequest } from "./sessions.js";
import { authMiddleware, type AuthEnv } from "./middleware.js";
import { tryConsume } from "../shared/rate-limit.js";
import { clientIp } from "../shared/request-ip.js";
import {
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_OFFLINE,
} from "./oauth-metadata.js";
import {
  upsertClient,
  getClient,
  issueCode,
  redeemCode,
  revokeIfReplayed,
  issueTokens,
  rotateRefreshToken,
  revokeByToken,
  revokeGrant,
  listConnectedApps,
  ACCESS_TTL_SECONDS,
  type OAuthClient,
} from "./oauth-store.js";

export const oauthRoutes = new Hono<AuthEnv>();

const GRANTABLE = new Set([SCOPE_READ, SCOPE_WRITE, SCOPE_OFFLINE]);

// Registration is open and unauthenticated, so cap it. Generous per IP:
// hosted connectors (claude.ai) register from a few shared vendor addresses.
const REGISTER_LIMIT = { max: 60, windowMs: 10 * 60_000 };
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;
// The secrets are 256-bit, so these only bound cheap request floods.
const TOKEN_LIMIT = { max: 120, windowMs: 60_000 };
const REVOKE_LIMIT = { max: 60, windowMs: 60_000 };

/** RFC 7636: an S256 challenge is BASE64URL(SHA256(...)) — exactly 43 chars. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1: 43–128 unreserved characters. */
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** This server's one resource (RFC 8707), as the metadata advertises it. */
function mcpResource(): string {
  return `${config.PUBLIC_BASE_URL.replace(/\/+$/, "")}/mcp`;
}

/** Loopback for a native client means http(s) on localhost — no custom schemes. */
function isLoopbackUri(u: URL): boolean {
  return (
    (u.protocol === "http:" || u.protocol === "https:") &&
    (u.hostname === "localhost" || u.hostname === "127.0.0.1")
  );
}

/** The request values the consent page showed, which the approval must match. */
interface ConsentFields {
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  resource: string;
}

/**
 * The consent form's CSRF token: an HMAC over the exact request shown, keyed
 * by the session id. The session id sits in an httpOnly cookie, so another
 * origin can neither read nor forge the token; binding the fields means the
 * POST cannot widen scope, or swap the challenge, state or redirect, without
 * failing the check. (Anyone holding the session id already holds the
 * session, so a separate server key would protect nothing more.)
 */
function consentCsrf(sessionId: string, f: ConsentFields): string {
  return createHmac("sha256", sessionId)
    .update(
      JSON.stringify([
        "oauth-consent",
        f.client_id,
        f.redirect_uri,
        f.scope,
        f.state,
        f.code_challenge,
        f.resource,
      ]),
    )
    .digest("hex");
}

function csrfMatches(sessionId: string, f: ConsentFields, presented: string): boolean {
  const a = Buffer.from(consentCsrf(sessionId, f));
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Every response from this router is JSON unless it is the consent page. */
function oauthError(
  c: Context,
  status: ContentfulStatusCode,
  error: string,
  description?: string,
) {
  return c.json(
    description ? { error, error_description: description } : { error },
    status,
  );
}

/** 404 the whole surface while the feature is off. */
oauthRoutes.use("*", async (c, next) => {
  if (!config.MCP_OAUTH_ENABLED) return c.json({ error: "Not found" }, 404);
  if (!config.PUBLIC_BASE_URL)
    return oauthError(
      c,
      503,
      "server_error",
      "PUBLIC_BASE_URL must be set to run the authorization server.",
    );
  await next();
  // Tokens (RFC 6749 §5.1), the consent page (email, CSRF token) and the
  // login shell must never sit in a browser or proxy cache.
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  // The consent page must not be framed, whatever FRAME_ANCESTORS allows for
  // the rest of the app: a framed "Connect" button is a clickjacking target.
  // The app-wide header middleware keeps a frame-ancestors a handler set.
  c.header("Content-Security-Policy", "frame-ancestors 'none'");
});

// ─── Dynamic client registration (RFC 7591) ───────────────────────────────

/**
 * Loopback redirect URIs are matched with the port ignored, per RFC 8252 §7.3.
 * Claude Code binds an ephemeral port per session and declares
 * `http://localhost/callback` + `http://127.0.0.1/callback`, so an exact-string
 * comparison would reject every real request from it.
 */
function redirectUriAllowed(registered: string[], presented: string): boolean {
  let p: URL;
  try {
    p = new URL(presented);
  } catch {
    return false;
  }
  // Anything not loopback must match exactly, and must be https.
  const isLoopback = isLoopbackUri(p);
  if (!isLoopback && p.protocol !== "https:") return false;

  return registered.some((r) => {
    if (r === presented) return true;
    if (!isLoopback) return false;
    let reg: URL;
    try {
      reg = new URL(r);
    } catch {
      return false;
    }
    return (
      reg.hostname === p.hostname &&
      reg.pathname === p.pathname &&
      reg.protocol === p.protocol
    );
  });
}

oauthRoutes.post("/register", async (c) => {
  if (!tryConsume(`oauth-register:ip:${clientIp(c)}`, REGISTER_LIMIT))
    return oauthError(c, 429, "slow_down", "Too many registrations. Try again later.");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object")
    return oauthError(c, 400, "invalid_client_metadata", "Body must be JSON.");

  const uris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u: unknown) => typeof u === "string")
    : [];
  if (uris.length === 0)
    return oauthError(
      c,
      400,
      "invalid_redirect_uri",
      "At least one redirect_uri is required.",
    );
  if (
    uris.length > MAX_REDIRECT_URIS ||
    uris.some((u: string) => u.length > MAX_REDIRECT_URI_LENGTH)
  )
    return oauthError(
      c,
      400,
      "invalid_redirect_uri",
      `At most ${MAX_REDIRECT_URIS} redirect_uris, each at most ${MAX_REDIRECT_URI_LENGTH} characters.`,
    );
  for (const u of uris) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return oauthError(c, 400, "invalid_redirect_uri", `Not a URL: ${u}`);
    }
    if (parsed.protocol !== "https:" && !isLoopbackUri(parsed))
      return oauthError(
        c,
        400,
        "invalid_redirect_uri",
        "Redirect URIs must be https, or loopback for a native client.",
      );
  }

  const clientId = `cnc_${randomBytes(16).toString("hex")}`;
  // Strip control and format characters (bidi overrides, zero-width): they
  // let a name display as something else on the consent page.
  const cleaned =
    typeof body.client_name === "string"
      ? body.client_name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 120)
      : "";
  const name = cleaned || "Unnamed client";
  await upsertClient({
    client_id: clientId,
    client_name: name,
    redirect_uris: uris,
    kind: "dcr",
  });
  // A public client: no secret issued, so none can leak. PKCE is what binds
  // the code to the client instead.
  return c.json(
    {
      client_id: clientId,
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
});

// ─── Authorization ────────────────────────────────────────────────────────

interface AuthzParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  resource: string | null;
}

/**
 * Validate the authorization request.
 *
 * Two classes of failure, and the difference matters: a bad `client_id` or
 * `redirect_uri` must be shown to the USER, because redirecting an
 * unvalidated URI is the open-redirect this check exists to prevent.
 * Everything else redirects the error back to the (now trusted) client.
 */
async function parseAuthz(
  c: Context,
): Promise<
  | { ok: true; params: AuthzParams; client: OAuthClient }
  | { ok: false; showUser: string }
  | { ok: false; redirect: string }
> {
  const q = c.req.query();
  const clientId = String(q.client_id ?? "");
  const redirectUri = String(q.redirect_uri ?? "");
  if (!clientId) return { ok: false, showUser: "Missing client_id." };

  const client = await getClient(clientId);
  if (!client)
    return { ok: false, showUser: "Unknown client. Try connecting again." };
  if (!redirectUri || !redirectUriAllowed(client.redirect_uris, redirectUri))
    return {
      ok: false,
      showUser: "This client asked to be sent somewhere it isn't registered for.",
    };

  const state = String(q.state ?? "");
  const fail = (error: string, description: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    return { ok: false as const, redirect: u.toString() };
  };

  if (String(q.response_type ?? "") !== "code")
    return fail("unsupported_response_type", "Only response_type=code is supported.");
  // PKCE is mandatory, not negotiable: this is a public client and the code
  // is otherwise bearer-only.
  if (String(q.code_challenge_method ?? "") !== "S256")
    return fail("invalid_request", "code_challenge_method must be S256.");
  const codeChallenge = String(q.code_challenge ?? "");
  if (!S256_CHALLENGE.test(codeChallenge))
    return fail("invalid_request", "code_challenge must be a 43-character S256 value.");

  // RFC 8707: this server is one resource. Anything else is a token request
  // for somewhere we are not, so refuse it rather than mint an ambiguous grant.
  const resource = q.resource ? String(q.resource).replace(/\/+$/, "") : null;
  if (resource && resource !== mcpResource())
    return fail("invalid_target", `resource must be ${mcpResource()}.`);

  const requested = String(q.scope ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const scopes = requested.length ? requested : [SCOPE_READ];
  const unknown = scopes.filter((s) => !GRANTABLE.has(s));
  if (unknown.length)
    return fail("invalid_scope", `Unknown scope: ${unknown.join(", ")}`);

  // Write implies read. Normalising here rather than at enforcement time
  // means the consent screen LISTS the read permission the grant will really
  // have, instead of quietly conferring it later — the screen and the token
  // must describe the same thing.
  if (scopes.includes(SCOPE_WRITE) && !scopes.includes(SCOPE_READ))
    scopes.unshift(SCOPE_READ);
  // Every grant stays connected. Registration already promises the
  // refresh_token grant, and a client that skipped the challenge's scope (a
  // local app, typically) otherwise lost its only token after an hour. A
  // client that never refreshes just ignores the extra field. Added here, like
  // read above, so the consent screen lists it.
  if (!scopes.includes(SCOPE_OFFLINE)) scopes.push(SCOPE_OFFLINE);

  return {
    ok: true,
    params: {
      clientId,
      redirectUri,
      scope: scopes.join(" "),
      state,
      codeChallenge,
      // Validated above; recorded on the grant. Tokens are only accepted on
      // /mcp and /index, so there is no second audience to confuse it with.
      resource,
    },
    client,
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );
}

const SCOPE_TEXT: Record<string, string> = {
  [SCOPE_READ]: "Read the nests you have access to",
  [SCOPE_WRITE]:
    "Create, edit, move and delete documents in those nests, submit them for review, and create nests",
  [SCOPE_OFFLINE]: "Stay connected without asking you again",
};

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#111;--muted:#666;--bg:#fff;--line:#e3e3e3;--accent:#2f6f4f}
@media(prefers-color-scheme:dark){:root{--fg:#eee;--muted:#9a9a9a;--bg:#161616;--line:#2c2c2c;--accent:#63b98c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:420px;border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:19px;margin:0 0 6px}
p.sub{color:var(--muted);margin:0 0 20px;font-size:14px}
ul{margin:0 0 20px;padding:0;list-style:none}
li{padding:8px 0;border-top:1px solid var(--line);font-size:14px}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
input{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--fg);font-size:14px}
.row{display:flex;gap:10px;margin-top:22px}
button{flex:1;padding:10px;border-radius:7px;border:1px solid var(--line);background:transparent;color:var(--fg);font-size:14px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.err{color:#c0392b;font-size:13px;margin-top:12px;min-height:1em}
code{font-size:12px;color:var(--muted);word-break:break-all}
p.dest{font-size:13px;margin:0 0 10px;padding:9px 11px;border:1px solid var(--line);border-radius:7px;word-break:break-all}
</style></head><body><div class="card">${inner}</div></body></html>`;
}

oauthRoutes.get("/authorize", async (c, next) => {
  const parsed = await parseAuthz(c);
  if (!parsed.ok) {
    if ("redirect" in parsed) return c.redirect(parsed.redirect, 302);
    return c.html(
      page(
        "Can't continue",
        `<h1>Can't continue</h1><p class="sub">${esc(parsed.showUser)}</p>`,
      ),
      400,
    );
  }
  const { params, client } = parsed;

  const sessionId = getSessionIdFromRequest(c);
  const userId = sessionId ? await resolveSession(sessionId) : null;
  // Open mode has no accounts to sign in to, and the app there counts as
  // signed in — sending the user to log in would bounce straight back here.
  if (!userId && config.AUTH_MODE === "open")
    return c.html(
      page(
        "Can't continue",
        `<h1>Can't continue</h1><p class="sub">Agent sign-in needs user accounts. Ask an administrator to set AUTH_MODE=key.</p>`,
      ),
      400,
    );
  if (!userId) {
    // Show the app's own login page right here, URL and params intact: the
    // SPA catch-all serves the shell to a browser navigation, and the UI
    // reloads this URL once the user has signed in (ui/src/lib/oauth-return.ts).
    return next();
  }

  const scopeList = params.scope
    .split(" ")
    .map((s) => `<li>${esc(SCOPE_TEXT[s] ?? s)}</li>`)
    .join("");

  // Round-trips the exact validated request back to the decision endpoint, so
  // the POST cannot widen scope or change the redirect.
  const fields: ConsentFields = {
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scope,
    state: params.state,
    code_challenge: params.codeChallenge,
    resource: params.resource ?? "",
  };
  const hidden = Object.entries({ ...fields, csrf: consentCsrf(sessionId!, fields) })
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${k}" value="${esc(String(v))}">`,
    )
    .join("");

  // Registration is open (RFC 7591), so `client_name` is whatever the
  // registering party typed — "Claude" is not evidence of anything. The
  // destination is the part a person can actually check, so show it.
  let destOrigin = params.redirectUri;
  try {
    destOrigin = new URL(params.redirectUri).origin;
  } catch {
    // parseAuthz already validated this parses; belt and braces.
  }

  const email = (await getDb().get("SELECT email FROM users WHERE id = ?", [
    userId,
  ])) as { email?: string } | undefined;

  return c.html(
    page(
      "Authorize",
      `<h1>Connect ${esc(client.client_name)}?</h1>
<p class="sub">Signed in as ${esc(email?.email ?? "you")}. It will be able to:</p>
<ul>${scopeList}</ul>
<p class="dest">Your approval will be sent to <strong>${esc(destOrigin)}</strong>.</p>
<p class="sub">Anyone can register a client under any name, so check that address is the app you meant. It sees exactly what you can see — nothing more. Disconnect it at any time under <strong>Connected apps</strong>.</p>
<form method="POST" action="/oauth/authorize/decision">
  ${hidden}
  <div class="row">
    <button type="submit" name="decision" value="deny">Cancel</button>
    <button class="primary" type="submit" name="decision" value="allow">Connect</button>
  </div>
</form>`,
    ),
  );
});

oauthRoutes.post("/authorize/decision", async (c) => {
  const form = await c.req
    .parseBody()
    .catch(() => ({}) as Record<string, unknown>);
  const clientId = String(form.client_id ?? "");
  const redirectUri = String(form.redirect_uri ?? "");
  const state = String(form.state ?? "");

  // Re-validate from scratch. The form is user-controlled: never trust it to
  // name a redirect the client did not register.
  const client = await getClient(clientId);
  if (!client || !redirectUriAllowed(client.redirect_uris, redirectUri))
    return c.html(
      page(
        "Can't continue",
        `<h1>Can't continue</h1><p class="sub">That client or redirect is no longer valid.</p>`,
      ),
      400,
    );

  const out = new URL(redirectUri);
  if (state) out.searchParams.set("state", state);

  if (String(form.decision ?? "") !== "allow") {
    out.searchParams.set("error", "access_denied");
    return c.redirect(out.toString(), 302);
  }

  const sessionId = getSessionIdFromRequest(c);
  const userId = sessionId ? await resolveSession(sessionId) : null;
  if (!userId) {
    out.searchParams.set("error", "access_denied");
    out.searchParams.set("error_description", "Session expired before approval.");
    return c.redirect(out.toString(), 302);
  }
  // Only an approval needs this: it is the one decision that issues a code.
  // The token covers every field below, so none can differ from the page.
  const fields: ConsentFields = {
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: String(form.scope ?? ""),
    state,
    code_challenge: String(form.code_challenge ?? ""),
    resource: String(form.resource ?? ""),
  };
  if (!csrfMatches(sessionId!, fields, String(form.csrf ?? "")))
    return c.html(
      page(
        "Can't continue",
        `<h1>Can't continue</h1><p class="sub">This approval did not come from the consent page. Try connecting again.</p>`,
      ),
      403,
    );

  // The CSRF check proved these are the values /authorize validated and showed.
  const code = await issueCode({
    clientId,
    userId,
    redirectUri,
    scope: fields.scope,
    codeChallenge: fields.code_challenge,
    resource: fields.resource || null,
  });
  out.searchParams.set("code", code);
  return c.redirect(out.toString(), 302);
});

// ─── Token ────────────────────────────────────────────────────────────────

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) === challenge. */
function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

oauthRoutes.post("/token", async (c) => {
  if (!tryConsume(`oauth-token:ip:${clientIp(c)}`, TOKEN_LIMIT))
    return oauthError(c, 429, "slow_down", "Too many token requests. Try again later.");
  // RFC 6749 §4.1.3 — form-urlencoded, not JSON. Frameworks that default to
  // JSON-only body parsing answer 415 here and break every client.
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const grantType = String(form.grant_type ?? "");
  const clientId = String(form.client_id ?? "");
  if (!clientId)
    return oauthError(c, 400, "invalid_client", "client_id is required.");

  if (grantType === "refresh_token") {
    const result = await rotateRefreshToken(
      String(form.refresh_token ?? ""),
      clientId,
    );
    // RFC 6749 error code, not a custom one: clients branch on invalid_grant
    // to decide whether to re-authorize rather than retry.
    if (!result.ok)
      return oauthError(c, 400, "invalid_grant", "Refresh token is not valid.");
    return c.json({
      access_token: result.tokens.accessToken,
      token_type: "Bearer",
      expires_in: result.tokens.expiresIn,
      refresh_token: result.tokens.refreshToken,
      scope: result.tokens.scope,
    });
  }

  if (grantType !== "authorization_code")
    return oauthError(
      c,
      400,
      "unsupported_grant_type",
      "Supported: authorization_code, refresh_token.",
    );

  // Client, redirect and PKCE are checked BEFORE the code is spent (see
  // redeemCode): a presenter who only saw the code cannot burn it, nor make
  // the real exchange read as a replay and revoke the user's grant.
  const presented = String(form.code ?? "");
  const redirectUri = String(form.redirect_uri ?? "");
  const verifier = String(form.code_verifier ?? "");
  const redeemed = await redeemCode(
    presented,
    (row) =>
      row.clientId === clientId &&
      row.redirectUri === redirectUri &&
      PKCE_VERIFIER.test(verifier) &&
      pkceMatches(verifier, row.codeChallenge),
  );
  // One answer for every failure: which check failed is not the caller's to
  // learn. A replay has already revoked the grant inside redeemCode.
  if (!redeemed.ok)
    return oauthError(c, 400, "invalid_grant", "Authorization code is not valid.");
  const code = redeemed.code;

  const client = await getClient(clientId);
  const tokens = await issueTokens({
    userId: code.userId,
    clientId,
    clientName: client?.client_name ?? "Unnamed client",
    scope: code.scope,
    resource: code.resource,
    withRefresh: code.scope.split(" ").includes(SCOPE_OFFLINE),
  });
  await revokeIfReplayed(presented, code);

  return c.json({
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    scope: tokens.scope,
  });
});

// ─── Revocation (RFC 7009) ────────────────────────────────────────────────

oauthRoutes.post("/revoke", async (c) => {
  if (!tryConsume(`oauth-revoke:ip:${clientIp(c)}`, REVOKE_LIMIT))
    return oauthError(c, 429, "slow_down", "Too many requests. Try again later.");
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const token = String(form.token ?? "");
  if (token) await revokeByToken(token);
  // RFC 7009: always 200, even for an unknown token — the endpoint must not
  // become an oracle for which tokens exist.
  return c.json({});
});

// ─── Connected apps (a person's own grants) ───────────────────────────────

/**
 * The Connected apps page: list your agents, and disconnect one. Signed-in
 * session or a user-level key only. A key scoped to one nest is refused, the
 * same as for API keys: it is narrower than the account it would manage.
 * An OAuth access token never reaches here — authMiddleware does not accept
 * one — so a connected app cannot list or disconnect its siblings.
 */
function refuseNestScoped(c: Context<AuthEnv>) {
  if (!c.get("nestScope")) return null;
  return c.json(
    { error: "This API key is scoped to one nest and can't manage connected apps. Use the web app." },
    403,
  );
}

oauthRoutes.get("/connected", authMiddleware, async (c) => {
  const refused = refuseNestScoped(c);
  if (refused) return refused;
  return c.json({ apps: await listConnectedApps(c.get("userId")) });
});

oauthRoutes.delete("/connected/:clientId", authMiddleware, async (c) => {
  const refused = refuseNestScoped(c);
  if (refused) return refused;
  // Scoped to the caller's own tokens: someone else's client id revokes
  // nothing and reads as not found.
  const revoked = await revokeGrant(c.get("userId"), c.req.param("clientId"));
  if (!revoked) return c.json({ error: "No connected app with that id." }, 404);
  return c.json({ revoked: true });
});
