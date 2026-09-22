---
"@promptowl/contextnest-community": minor
---

MCP clients can now sign a person in, instead of carrying a shared API key. Off by default (`MCP_OAUTH_ENABLED`).

The server has always decided what an MCP caller may read on a per-user basis — `buildNestIndex` gates every nest through `canRead(nestId, userId)`. What was missing was identity at the door. An API key pasted into Claude, ChatGPT or Cursor by four people resolves all four to the same user, so they all see whatever that key's owner can see. Turning this on means each person arrives as themselves and sees their own nests.

The flow is the standard one: a client registers (`POST /oauth/register`, RFC 7591), sends the person to `/oauth/authorize`, and exchanges the resulting code at `/oauth/token` for an access token and, when `offline_access` was granted, a refresh token. Sign-in on the consent page reuses the existing login, so nothing about accounts or passwords changes; on a server with SSO configured the same session applies. Tokens can be revoked at `/oauth/revoke`.

Security properties worth naming, each covered by a test: PKCE S256 is required, not negotiated. Refresh tokens rotate on every use and the replaced one dies immediately, as OAuth 2.1 requires for public clients. An authorization code is single-use, and a code presented twice revokes the entire grant it produced rather than merely refusing the second exchange — a code seen twice has leaked. A `redirect_uri` that a client never registered is shown to the person rather than redirected to, because redirecting an unvalidated URI is the open redirect the check exists to prevent. Loopback redirects match with the port ignored (RFC 8252), which is what native clients like Claude Code need. Every credential is stored as a SHA-256 hash, never in the clear.

The scopes are a real boundary, not a label: a grant approved for `nests:read` is refused every write tool, so the consent screen's wording matches what the connection can actually do. Read-only tools are an allow-list, so a tool added later requires write access by default rather than silently inheriting read.

The consent page names the address your approval will be sent to. Registration is open, so a client's name is whatever its author typed — the destination is the part a person can actually check.

Existing API keys and MCP tickets are untouched and keep working exactly as before; this only adds a way in. An OAuth grant is never narrowed to a single nest, so one connection reads across every nest that person can see.
