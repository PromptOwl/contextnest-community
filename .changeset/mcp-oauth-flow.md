---
"@promptowl/contextnest-community": minor
---

MCP clients can now sign a person in, instead of carrying a shared API key. Off by default (`MCP_OAUTH_ENABLED`, also a runtime toggle under Settings → Single sign-on → Agent OAuth). It requires `PUBLIC_BASE_URL`, and `/admin/settings` refuses to enable it without one. With the flag off, `/.well-known/*` and `/oauth/*` return 404 and `/mcp` answers unauthenticated callers as before.

The server has always decided what an MCP caller may read on a per-user basis — `buildNestIndex` gates every nest through `canRead(nestId, userId)`. What was missing was identity at the door. An API key pasted into Claude, ChatGPT or Cursor by four people resolves all four to the same user, so they all see whatever that key's owner can see. Turning this on means each person arrives as themselves and sees their own nests.

The flow is the standard one. An unauthenticated `/mcp` request gets a `401` whose `WWW-Authenticate` header points at the discovery documents (`/.well-known/oauth-protected-resource/mcp`, RFC 9728, and `/.well-known/oauth-authorization-server`, RFC 8414). The client registers (`POST /oauth/register`, RFC 7591), sends the person to `/oauth/authorize`, and exchanges the resulting code at `/oauth/token` for an access token and, when `offline_access` was granted, a refresh token. A signed-out person sees the app's normal login page at the authorize URL — password, SSO and PromptOwl sign-in all work — and lands on the consent page once signed in. Tokens can be revoked at `/oauth/revoke`. Clients register through DCR; Client ID Metadata Documents are not advertised yet.

Security properties, each covered by a test:

- PKCE S256 is required, with RFC 7636 value shapes. Client, redirect and verifier are checked before a code is spent, so someone who only saw a code cannot burn it or revoke the grant.
- A code is single-use. One redeemed twice by a presenter holding the verifier revokes the whole grant, including tokens minted by a racing exchange. A rotated refresh token presented again also revokes the grant.
- The consent page shows where the approval goes, cannot be framed, and is not cached. Its CSRF token binds the client, redirect, scope, state, challenge and resource it showed, so an approval cannot differ from the page. Control and bidi characters are removed from client names.
- Scopes are a real boundary. `nests:read` is refused every write tool, `/index` and the read tools need read scope, and `nests:write` implies read and says so on the consent page. Read-only tools are an allow-list, so a new tool requires write by default.
- An expired or revoked token gets `401` with `error="invalid_token"`, so clients refresh or re-authorize. A password change, an admin password reset or removing the user revokes every grant.
- Every credential is stored as a SHA-256 hash. Token responses carry `Cache-Control: no-store`. Registration, token and revocation are rate-limited per IP, and idle clients, expired codes and dead tokens are purged hourly.

Existing API keys and MCP tickets are untouched and keep working exactly as before; this only adds a way in. An OAuth grant is never narrowed to a single nest, so one connection reads across every nest that person can see.
