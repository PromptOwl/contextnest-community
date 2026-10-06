---
"@promptowl/contextnest-community": minor
---

Groundwork for MCP clients signing in, instead of carrying a shared API key: the server can now advertise itself as an OAuth 2.1 authorization server. Off by default, and off means the surface does not exist.

The server already decides what an MCP caller can read per user — `buildNestIndex` gates every nest through `canRead(nestId, userId)`. What was missing is identity at the door. An API key pasted into Claude or ChatGPT by several people resolves all of them to the same user, so they all see whatever its owner can see. OAuth is what makes each person arrive as themselves.

This release adds the discovery half of that flow: `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414), plus the `401` with a `WWW-Authenticate: Bearer resource_metadata="…"` header that is the only thing that starts an authorization flow — clients ignore that header on a `200` and treat a tool-level error as a tool error.

`MCP_OAUTH_ENABLED` turns it on, as an env var or a runtime toggle under Settings → Single sign-on → Agent OAuth. It requires `PUBLIC_BASE_URL`, and `/admin/settings` refuses to enable it without one: the metadata has to name this server's exact address, and a guessed value fails the client's check with no useful error. With the flag off, `/.well-known/*` returns 404 as before and `/mcp` answers unauthenticated callers unchanged.

The authorization, token and revocation endpoints the metadata points at are not built yet, so the flag should stay off outside development until they land.
