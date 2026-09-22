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
import { Hono } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { resolveSession, getSessionIdFromRequest } from "./sessions.js";
import {
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_OFFLINE,
} from "./oauth-metadata.js";
import {
  upsertClient,
  getClient,
  issueCode,
  consumeCode,
  issueTokens,
  rotateRefreshToken,
  revokeByToken,
  revokeAllForUserClient,
  ACCESS_TTL_SECONDS,
  type OAuthClient,
} from "./oauth-store.js";

export const oauthRoutes = new Hono();

const GRANTABLE = new Set([SCOPE_READ, SCOPE_WRITE, SCOPE_OFFLINE]);

/** Every response from this router is JSON unless it is the consent page. */
function oauthError(
  c: any,
  status: number,
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
  return next();
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
  const isLoopback = p.hostname === "localhost" || p.hostname === "127.0.0.1";
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
  for (const u of uris) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return oauthError(c, 400, "invalid_redirect_uri", `Not a URL: ${u}`);
    }
    const loopback =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !loopback)
      return oauthError(
        c,
        400,
        "invalid_redirect_uri",
        "Redirect URIs must be https, or loopback for a native client.",
      );
  }

  const clientId = `cnc_${randomBytes(16).toString("hex")}`;
  const name =
    typeof body.client_name === "string" && body.client_name.trim()
      ? body.client_name.trim().slice(0, 120)
      : "Unnamed client";
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
  c: any,
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
  if (!codeChallenge)
    return fail("invalid_request", "code_challenge is required.");

  const requested = String(q.scope ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const scopes = requested.length ? requested : [SCOPE_READ];
  const unknown = scopes.filter((s) => !GRANTABLE.has(s));
  if (unknown.length)
    return fail("invalid_scope", `Unknown scope: ${unknown.join(", ")}`);

  return {
    ok: true,
    params: {
      clientId,
      redirectUri,
      scope: scopes.join(" "),
      state,
      codeChallenge,
      // RFC 8707. Recorded so the token can be audience-bound to the resource
      // the client actually asked for.
      resource: q.resource ? String(q.resource) : null,
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
  [SCOPE_WRITE]: "Create and edit documents in those nests",
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

oauthRoutes.get("/authorize", async (c) => {
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

  const scopeList = params.scope
    .split(" ")
    .map((s) => `<li>${esc(SCOPE_TEXT[s] ?? s)}</li>`)
    .join("");

  // Round-trips the exact validated request back to the decision endpoint, so
  // the POST cannot widen scope or change the redirect.
  const hidden = Object.entries({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scope,
    state: params.state,
    code_challenge: params.codeChallenge,
    resource: params.resource ?? "",
  })
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${k}" value="${esc(String(v))}">`,
    )
    .join("");

  if (!userId) {
    const user = (await getDb().get("SELECT 1 AS ok FROM users LIMIT 1")) as
      | { ok?: number }
      | undefined;
    const hint = user?.ok
      ? "Sign in to continue."
      : "No account exists on this server yet.";
    return c.html(
      page(
        "Sign in",
        `<h1>Sign in</h1>
<p class="sub">${esc(hint)} <strong>${esc(client.client_name)}</strong> is waiting to connect.</p>
<form id="f">
  <label for="e">Email</label><input id="e" type="email" autocomplete="username" required>
  <label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required>
  <div class="row"><button class="primary" type="submit">Sign in</button></div>
  <div class="err" id="err"></div>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      email: document.getElementById('e').value,
      password: document.getElementById('p').value,
    }),
  });
  if (res.ok) { location.reload(); return; }
  const b = await res.json().catch(() => ({}));
  err.textContent = b.error || 'Sign-in failed.';
});
</script>`,
      ),
    );
  }

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
<p class="sub">Anyone can register a client under any name, so check that address is the app you meant. It sees exactly what you can see — nothing more, and you can disconnect it at any time.</p>
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
  const form = await c.req.parseBody();
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

  const scope = String(form.scope ?? SCOPE_READ)
    .split(/\s+/)
    .filter((s) => GRANTABLE.has(s))
    .join(" ");
  const codeChallenge = String(form.code_challenge ?? "");
  if (!scope || !codeChallenge) {
    out.searchParams.set("error", "invalid_request");
    return c.redirect(out.toString(), 302);
  }

  const code = await issueCode({
    clientId,
    userId,
    redirectUri,
    scope,
    codeChallenge,
    resource: form.resource ? String(form.resource) || null : null,
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

  const consumed = await consumeCode(String(form.code ?? ""));
  if (!consumed.ok) {
    if (consumed.reason === "replayed") {
      // A code presented twice has leaked. OAuth 2.1 says to treat that as a
      // compromise of the grant it produced, so everything descended from it
      // goes — refusing only the second exchange would leave the attacker's
      // tokens (or the victim's) live.
      const row = (await getDb().get(
        "SELECT user_id, client_id FROM oauth_codes WHERE code_hash = ?",
        [createHash("sha256").update(String(form.code ?? "")).digest("hex")],
      )) as { user_id?: string; client_id?: string } | undefined;
      if (row?.user_id && row?.client_id)
        await revokeAllForUserClient(row.user_id, row.client_id);
    }
    return oauthError(c, 400, "invalid_grant", "Authorization code is not valid.");
  }
  const code = consumed.code;

  // The code was issued to one client, for one redirect. Both must match or
  // an attacker who intercepted the code can redeem it as someone else.
  if (code.clientId !== clientId)
    return oauthError(c, 400, "invalid_grant", "Code was issued to another client.");
  if (String(form.redirect_uri ?? "") !== code.redirectUri)
    return oauthError(c, 400, "invalid_grant", "redirect_uri does not match.");

  const verifier = String(form.code_verifier ?? "");
  if (!verifier || !pkceMatches(verifier, code.codeChallenge))
    return oauthError(c, 400, "invalid_grant", "PKCE verification failed.");

  const client = await getClient(clientId);
  const tokens = await issueTokens({
    userId: code.userId,
    clientId,
    clientName: client?.client_name ?? "Unnamed client",
    scope: code.scope,
    resource: code.resource,
    withRefresh: code.scope.split(" ").includes(SCOPE_OFFLINE),
  });

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
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const token = String(form.token ?? "");
  if (token) await revokeByToken(token);
  // RFC 7009: always 200, even for an unknown token — the endpoint must not
  // become an oracle for which tokens exist.
  return c.json({});
});
