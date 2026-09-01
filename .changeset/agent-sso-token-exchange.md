---
"@promptowl/contextnest-community": minor
---

Agent SSO: exchange an IdP ID token for a short-lived MCP bearer.

`POST /auth/token-exchange` (RFC 8693-shaped) lets an external agent, acting for
a user your IdP (Microsoft Entra / Google) has already authenticated, trade that
IdP's ID token for a scoped MCP bearer — no second login, no static API key.
**Off by default**, and it stays off until a superadmin enables it in
Settings → Single sign-on → Agent SSO (or sets the env vars).

Because the endpoint trusts a token minted elsewhere and hands back access, the
verification is the feature. The inbound `subject_token` is checked for
signature (the provider's JWKS, `RS256` pinned), issuer (exact per provider —
the tenant-scoped Entra issuer or Google's), audience (your configured client
id, so a token minted for another application cannot be replayed here), and
expiry, then the same `email_verified` + domain-allowlist policy as browser
login before the user is resolved or JIT-provisioned.

Provisioning **fails closed**: auto-provision with an empty
`OIDC_ALLOWED_DOMAINS` is refused at mint time (`no_account`) and refused at
save time by `/admin/settings`, because that combination would otherwise let
anyone with an account at a public IdP sign themselves up and walk away with a
bearer.

Minted bearers are signed with a dedicated `MCP_SIGNING_SECRET`, distinct from
the PromptOwl shared secret, so self-hosted deployments can issue their own; the
`/index` and `/mcp` acceptor verifies a ticket signed with either secret via
independent constant-time checks. Clearing that secret revokes every outstanding
bearer — turning the master flag off only stops minting.

Unlike the browser flow there is no session to bind, so the OIDC `nonce` binding
is deliberately dropped; trust rests on signature + issuer + audience + expiry +
`email_verified`. `scope: "mcp"` is a route allowlist, not a reduced permission
set — the bearer carries the user's full stewardship rights, so keep
`MCP_TOKEN_TTL_SECONDS` short. Both tradeoffs are written up in
`CONFIGURATION.md → Agent SSO (token exchange)`.

Alongside it: the OIDC discovery cache holds one entry per issuer instead of one
entry total, so OIDC login and the two token-exchange providers no longer evict
each other and refetch JWKS on every alternating request.
