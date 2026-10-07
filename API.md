# ContextNest Community — API Reference

Base URL: `http://localhost:3838`
Default port: `3838` (override via `PORT` env)

## Authentication

Two methods, evaluated in order:

1. **Cookie session** — `cnst_session=<id>` (set by `/auth/login` and `/auth/register`). Browser default.
2. **Bearer API key** — `Authorization: Bearer cnst_<token>` (issued by `/auth/keys`). Use for Postman / external tools.

Anonymous open mode (`AUTH_MODE=open`) bypasses auth on most read endpoints.

### Nest-scoped API keys

A key minted with `nest_id` reaches **that one nest and nothing else**. It is deny-by-default: a request outside the list below answers **403** `{ "error": "This API key is scoped to one nest and can't …", "code": "nest_scoped_key" }`, before the route's own checks run, so a route added later is closed to nest keys until it is allowed on purpose.

| A nest-scoped key **can** reach | Notes |
|---|---|
| `/nests/<its nest>` and everything under it, including `/nests/<its nest>/mcp` | The owner's permission on that nest still applies. |
| `GET /nests`, `GET /search`, `GET /stats` | Narrowed to its nest — other nests never appear. |
| `/mcp`, `GET /index` | Already filtered to its nest. |
| `/runs/<id>/*` | Only runs in its nest (403 otherwise). |
| `GET /health`, `GET /license/status`, `GET /llms.txt`, `GET /auth/admin-status` | Public / self-describing. |

Everything else is **403 `nest_scoped_key`** — notably `/auth/keys*` (a nest key can't mint, rotate, list or revoke keys, so it can't trade itself for a whole-account key), `POST /nests`, every other nest (`/nests/<other>/…` answers 403 "API key not authorized for this nest"; its MCP transport answers with a JSON-RPC error envelope), `/admin/*`, `/auth/teammates`, `/auth/invite`, `/auth/users/*`, `/auth/admin/*`, `/auth/profile`, `/auth/password`, `/teams*`, `/people*` and `/me/*` — even when the key's owner is a server admin. A session cookie sent alongside the key wins, as everywhere else. User-level keys (no `nest_id`) and sessions are unaffected.

### Headless access keys (API-only nests)

A nest **published headless** is handed out as read-only **access keys** — one per buyer or integration, labeled and revocable (see [`/nests/:nestId/headless`](#headless-publishing-api-only-nests-owner--admin) below). An access key is not a person's key: it belongs to its own service identity, which has no password, can never open a browser session, and never appears in people search, the teammates list or user counts. It reads **approved content only** (like an `org`/`public` reader) and only while the nest is published.

| An access key **can** | |
|---|---|
| MCP (`/nests/<its nest>/mcp` or `/mcp`): `context_list`, `context_get`, `context_query`, `context_search`, `context_resolve`, `context_overview`, `context_table_query`, `context_verify` (+ `nest_index` on `/mcp`) | What `ctx` issues against a remote nest. `tools/list` offers only these. |
| `GET /nests/<its nest>`, `…/nodes`, `…/nodes/<id>`, `…/search`, `…/context` | Approved content only. `GET /nests/<its nest>` returns the nest's public face only (id, name, slug, description, created) — not its owner, team shares or settings. |
| `POST /nests/<its nest>/context`, `…/query`, `…/table-query` | Retrieval queries. |
| `GET /nests`, `GET /index`, public routes | Show only its nest. |

Everything else is **403** `{ "code": "headless_reader" }` — the folder tree and the glossary (neither is approval-gated), every write, comments and annotations, version history, activity, reviews, stewards and collaborators, `GET …/export`, `context_export` and bundle export, hosted-artifact and PDF downloads, chat, workflow runs, pins, `/stats`, `/search`, and every account/admin route. MCP tools outside the list answer with a tool error. The allowlist is deny-by-default: a route or tool added later is closed to access keys until it is added on purpose.

> Headless is a **commercial boundary, not a cryptographic seal**: `ctx` needs document bodies, so a key holder can read every *approved* document one call at a time. It cannot browse, export, see drafts or history, or write.

All bodies are JSON unless noted. All errors return `{ "error": "msg" }` with appropriate HTTP status.

## Caller attribution (`client`)

`edited_by` names a person and a read names nobody, so neither answers *which
agent, in which session*. Every write body below, and every MCP tool call, takes
an optional `client` object that does ([spec §9.4](https://github.com/PromptOwl/ContextNest/blob/main/CONTEXT_NEST_SPEC.md)):

```json
{ "title": "API Design", "content": "…",
  "client": { "agent": "claude-code", "session_id": "s-9f2", "run": 7 } }
```

- `agent` and `session_id` are reserved; any other key is custom and is recorded
  verbatim. Values are scalars (string / number / boolean).
- A write that creates a version records it **on that version** — it comes back
  on `GET .../versions` and on MCP `context_versions` (in the prose and the
  structured payload). Every path that seals a version takes it: create, edit,
  approve, revert, and import (`POST /nests/import`, `POST /nests/unsynced/sync`,
  which stamp every row they seed), plus `POST /review-queue/bulk`, whose one
  block rides every approval in the batch. `POST .../submit-review` seals it
  into the engine's own version chain (`history.yaml`), which is the entry that
  submission appends. Every MCP tool call, and every REST
  call that accepts `client`, records it on the activity trace
  (`GET /admin/trace`, `GET /nests/:nestId/trace`, where it comes back as a
  parsed `client` object) — which is where a call that seals no version is
  attributed: a **read**, and a **rejection**, which commits no content.
- **Entirely optional.** No endpoint requires it and an unattributed call is a
  valid call. A call that carries none stores nothing rather than an empty
  object — "not attributed" and "attributed to nobody" are different claims.
- **A label, not an identity.** It is never authenticated, never used to
  authorize, and never an input to a hash chain, so histories written before the
  field existed keep verifying byte for byte. `editedBy` remains the
  authoritative authoring record.
- **Bounded**, because an untrusted caller writes it into an append-only audit
  trail: values ≤512 chars, ≤16 custom keys, scalars only → `400` otherwise. A
  near-miss on a reserved key (`sessionId`, `Agent`) is refused rather than
  filed as a custom key, which would look attributed and not be.
- The server fills what the transport already knows, **per key, under** anything
  the caller sent. Precedence is caller > env > connection: on MCP the
  connection means the `initialize` handshake's `clientInfo.name` and the
  transport's session id; behind that sits the label the operator gave the API
  key. `CONTEXTNEST_AGENT` / `CONTEXTNEST_SESSION_ID` are the env layer;
  `CONTEXTNEST_NO_ATTRIBUTION=1` derives nothing (a `client` the caller sent
  explicitly is still honoured). See `CONFIGURATION.md`.
- Note the `/mcp` endpoints are **stateless** — one server per request, no
  session issued — so a handshake's `clientInfo` is not in scope by the time a
  tool call arrives, and `agent` comes from the key label in practice. An agent
  that wants to name itself exactly should send `client` rather than rely on
  what the connection happens to report.

- **Treat a recorded `client` as untrusted text when you read it back.** The
  values are whatever the caller sent, stored verbatim and unescaped by design —
  an audit record that rewrites what the caller said is worth less than none —
  and `context_versions` prints `agent` into the prose an LLM client reads
  (`[via claude-code]`). That is the same standing as every other caller-written
  string this server serves back: document titles, bodies, change notes and
  review notes all reach an agent's context the same way. Bounds (≤512 chars,
  scalars) cap the size, not the content. Render it as data, never as
  instructions, and the usual rule applies to anything downstream: escape at the
  point of use. This server's own UI does — React escapes it as a text node, and
  nothing interpolates it into SQL (`client_json` is always a bound parameter).

Distinct from `metadata`, which is frontmatter: `metadata` describes the
document, `client` describes the call that touched it.

---

## 1. Auth

### POST `/auth/register`
Public **self sign-up** — creates a brand-new account only. Gated by `MANUAL_SIGN_IN`: allowed only in `open`; `invite-only` and `disabled` return `403`. It never sets the password on an already-provisioned (invited) account — that returns `409` (no email verification exists, so self-claiming would be account takeover). Invited users get a password from their admin (`/auth/invite` or admin reset), then log in and change it.

Body:
```json
{ "email": "user@x.com", "password": "secret123", "name": "Optional Name" }
```

Behavior:
- Email not in DB → create user → 201 + session cookie.
- Email in DB with `is_invited = 1` → **claim flow**: overwrite `password_hash`, set `name` if provided, flip `is_invited → 0`. Same `user.id` retained, so existing `api_keys` / `nest_collaborators` / `stewards` rows stay linked.
- Email in DB with `is_invited = 0` → 400 `Email already registered`.

Response (201):
```json
{ "user": { "id": "uuid", "email": "...", "name": null, "is_admin": false } }
```

Rate limit: per-IP.

### POST `/auth/login`
Body:
```json
{ "email": "user@x.com", "password": "secret123" }
```
200 + session cookie. 401 `Invalid credentials`. Rate-limited per IP and per email. Gated by `MANUAL_SIGN_IN` — returns `403` when set to `disabled` (`invite-only` still allows login).

### POST `/auth/logout`
Clears session cookie. 200.

### POST `/auth/keys` (auth required)
Mints an API key for the caller. A user may hold **several** keys — one per place they connect from — so rotating the key for one client doesn't disconnect the rest.

`label` is **required** and must be unique among the caller's keys (compared case-insensitively, after trimming): once the plaintext is gone the name is the only thing that tells two keys apart, so a list of identical entries makes revoking a guess. **400** if it's missing, blank, not a string, or longer than 60 characters; **409** on a duplicate name or at the per-user ceiling (20). Keys created before this rule keep their existing (possibly absent) label.
```json
{ "label": "cli", "nest_id": "optional — scope the key to one nest" }
```
Response (201):
```json
{ "api_key": "cnst_...", "id": "uuid", "key_prefix": "cnst_abc123...", "label": "cli", "nest_id": null }
```
**Plaintext shown once.** Omit `nest_id` for a **user-level key** (works on every nest the user can access — what the whole-brain Connect flow mints). With `nest_id` the key is **nest-scoped** — see [Nest-scoped API keys](#nest-scoped-api-keys) for exactly what it can reach. The caller must be able to reach that nest: an unknown nest, or one the caller has no access to, is **404** (the same answer for both, so this is no existence oracle). A nest-scoped key calling this endpoint gets **403 `nest_scoped_key`**.

### POST `/auth/keys/rotate` (auth required)
Replaces **one** key and returns its new plaintext; the caller's other keys are untouched.

`key_id` names the target. Omitting it is only accepted when the account holds exactly one key (pre-multi-key clients) — with several keys and no `key_id` the server answers **400** rather than guessing which to replace. **404** if the id isn't the caller's.

Scope resolution on the optional `nest_id` field: **absent** → keep the prior scope; **`null` (or `""`)** → clear to a user-level key; **a nest id** → scope to that nest (**404** unless the caller can reach it, and the old key is left alone). The response reports the new key's `nest_id`. Un-scoping has to come from a session or a user-level key — a nest-scoped key calling any `/auth/keys*` route gets **403 `nest_scoped_key`**. Same for `label` (absent keeps the prior label). Supplying a `label` that matches a *different* key of the caller's is **409**; renaming a key to what it is already called is fine.
```json
{ "key_id": "uuid", "label": "optional", "nest_id": "optional" }
```

### GET `/auth/keys` (auth required)
Lists the caller's keys — id, prefix, label, `nest_id`, `created_at`, `last_used_at` — oldest first. Never returns plaintext.

### DELETE `/auth/keys/:keyId` (auth required)
Revoke one key. 404 if the id isn't the caller's. Anything still using it stops working immediately.

### POST `/auth/password` (auth required)
```json
{ "current_password": "...", "new_password": "..." }
```

### PATCH `/auth/profile` (auth required)
Set the caller's display name (≤ 80 chars, trimmed). An empty string clears it, so the UI shows the email. Needs a session or API key even under `AUTH_MODE=open` — the anonymous caller gets `401`.
```json
{ "name": "Alan" }
```
Response: `{ "ok": true, "name": "Alan" }`

### POST `/auth/invite` (admin only)
Creates an invited user and returns a **temporary password** (once) for the admin to hand off. No API key is minted — teammates sign in with the temp password, then mint their own key from the Connect modal.
```json
{ "email": "teammate@x.com" }
```
- New email → user row with `is_invited = 1` and a temporary password.
- Any existing email → `409`, credentials untouched. The error says "already a member" once they've signed in (`is_invited = 0`), or "already invited but hasn't signed in yet" (`is_invited = 1`, including people a nest was shared with). Use Reset password to issue a new temporary password.

`is_invited` clears to `0` on the teammate's first successful login (or when they set their own password).

Response (201):
```json
{
  "temporary_password": "...",
  "user": { "id": "...", "email": "..." },
  "promptowl_sign_in": true,
  "emailed": true,
  "message": "Share this temporary password securely — it won't be shown again."
}
```
`emailed` — email is configured, so the invite email (password + sign-in link) was sent. `promptowl_sign_in` — PromptOwl sign-in is open to everyone, so the teammate may use it instead (the email says so too).

### GET `/auth/teammates` (admin only)
Returns all users + key counts. **Sorted: admins first, then `created_at DESC`.**
```json
{
  "teammates": [
    {
      "id": "uuid",
      "email": "...",
      "name": null,
      "is_admin": true,
      "is_invited": 0,
      "key_count": 1,
      "last_active": "2026-05-15T10:00:00Z"
    }
  ],
  "pending_stewards": ["unregistered@x.com"]
}
```
`is_invited = 1` → user was placeholder-created, has not yet claimed the account.

### POST `/auth/admin/reset-password/:userId` (admin only)
In-platform password reset — **no email server**. Provide a password, or omit it to have one generated and returned **once** for the admin to share.
```json
{ "password": "optional, min 8 chars" }
```
Response: `{ "ok": true, "email": "...", "keys_revoked": false, "temporary_password": "<only when generated>" }`. Invalidates the user's sessions but **keeps their API keys** (a reset shouldn't break a teammate's CLI/MCP). Revoke a key separately (`DELETE /auth/keys/:keyId`) if it may be compromised. The hash is never returned.

### DELETE `/auth/users/:userId` (admin only)
Removes a user — revokes api_keys, sessions, steward rows, and collaborator grants, then deletes the account. `400` if you target yourself; `409` if the user still owns nests (transfer/delete them first). Authored docs on disk are unaffected.

### POST `/auth/promptowl`
SSO via PromptOwl. Used by web UI; not typically called from Postman. Subject to `PROMPTOWL_SIGN_IN_GATE` — when `admin-only`/`disabled`, non-admins (or everyone) get `403` here.

### GET `/auth/admin-status`
Returns whether the caller is the license admin + license metadata.

### POST `/auth/device` / GET `/auth/device/poll`
Device-flow login. Also gated by `PROMPTOWL_SIGN_IN_GATE`.

### GET `/auth/sso`
One-click SSO auto-login from an **official community site** (**not for self-hosted deployments** — see below). A trusted site redirects a signed-in user here with a short-lived, single-use, audience-bound HS256 JWT ticket (`?ticket=...`). The server tries the ticket's signature against every configured official community site's secret (`GET/POST/PATCH/DELETE /admin/community-sites`, plus the legacy `OFFICIAL_COMMUNITY_SSO_SECRET`/`PUBLIC_BASE_URL` env-var pair for backward compatibility), checks `aud` against this deployment's own `PUBLIC_BASE_URL` (not the matched site's `url`, which is a display/uniqueness field only), enforces one-time-use via the ticket's `jti`, then provisions the user and starts a session (same provisioning + `PROMPTOWL_SIGN_IN_GATE` as `/auth/promptowl`). On success → `302` to `/`; on failure → `302` to `/?sso_error=<code>` (the SPA shows a toast). **When no official community site is configured** (i.e. every self-hosted server, by default) the feature is disabled and the endpoint bounces to `/?sso_error=not_supported`. That is the domain lock: without a matching secret no ticket can be verified, so the feature stays exclusive to configured official sites regardless of this redirect. Error codes: `not_supported`, `missing_ticket`, `invalid_ticket`, `bad_audience`, `ticket_used`, `rate_limited`, `sign_in_restricted`, `service_error` (DB/internal fault while redeeming the ticket).

### GET `/auth/oidc/login`
Starts generic **OIDC single sign-on** (Microsoft Entra ID, Google, or any spec-compliant IdP). Superadmin-configurable via `/admin/settings` (`oidc_*` fields) or the `OIDC_*` env vars — see `CONFIGURATION.md → Single sign-on (OIDC)`. Entirely separate from the PromptOwl flows above.

When enabled and fully configured: fetches the issuer's discovery document (cached in-process ~5 min), mints `state` + `nonce` + a PKCE S256 verifier into three short-lived (10 min) httpOnly `SameSite=Lax` cookies scoped to `Path=/auth/oidc`, and `302`s to the IdP's authorization endpoint with `response_type=code&scope=openid email profile`. When disabled/unconfigured → `302` to `/?sso_error=disabled` / `not_configured`. Rate-limited per IP.

### GET `/auth/oidc/callback`
The redirect URI (`<base url>/auth/oidc/callback` — register this exact URI at your IdP). Verifies the `state` param against the flow cookie, exchanges the code at the token endpoint (client secret + PKCE verifier), validates the ID token with the issuer's JWKS (signature, `iss`, `aud` = client id, `exp`, and the `nonce` claim against the flow cookie), extracts the email (`email`, falling back to `preferred_username` for Entra; normalized trim+lowercase), and enforces `oidc_allowed_domains`. Existing users are signed in; unknown users are JIT-provisioned when `oidc_auto_provision` is on (name from the `name` claim), else refused. Every successful login also upserts `users.department` from the optional string `department` claim (trimmed, whitespace collapsed, capped at 120 chars; absent claim clears the stored value) — read by the `oidc_department_tagging` feature (see `CONFIGURATION.md → Department auto-tagging`). On success → session cookie (identical to a password login) + `302` to `/`. On any failure → `302` to `/?sso_error=<code>`; codes: `disabled`, `not_configured`, `discovery_failed`, `provider_error`, `state_mismatch`, `exchange_failed`, `invalid_token`, `email_not_verified` (ID token carries `email_verified: false` — an absent claim is trusted; see the trust assumption in `CONFIGURATION.md → Single sign-on (OIDC)`), `domain_not_allowed`, `not_invited`, `rate_limited`, `service_error` (cause and fix for each: `CONFIGURATION.md → Troubleshooting SSO sign-in`). Flow cookies are cleared on every outcome. Rate-limited per IP.

### GET `/auth/oidc/logout`
RP-initiated logout for an SSO session. Deletes the current session server-side and clears the session cookie plus the `cnst_sso_session` marker. If the issuer advertises an `end_session_endpoint` (Entra/Okta/Keycloak; Google does not), `302`s the browser through it with `post_logout_redirect_uri=<base url>/` so the IdP session ends too; otherwise `302`s straight to `/`. Always clears cookies and always lands on `/`, even if discovery is unreachable. The SPA navigates here (instead of `POST /auth/logout`) only when the non-httpOnly `cnst_sso_session` marker cookie — set on OIDC callback success — is present, so password sessions keep the plain logout.

Related `/admin/settings` fields (GET/PATCH, server admin only — the license admin or a superadmin): `oidc_enabled`, `oidc_issuer` (https URL), `oidc_client_id`, `oidc_client_secret` (**write-only** — PATCH sets/replaces, `null` clears; GET returns only `oidc_client_secret_set: boolean`), `oidc_allowed_domains` (comma-separated), `oidc_auto_provision`, `oidc_department_tagging` (append `dept:<slugified-department>` to a new document's tags on create — create-only, no-op for users without a stored department). Enabling is refused unless issuer + client id + secret are all present.

### POST `/auth/token-exchange`
Exchange an IdP ID token for a short-lived, scoped **MCP bearer** (RFC 8693-shaped) — for an external agent acting on behalf of a user your IdP already authenticated. No session, no API key. **Off by default; security-critical** — see `CONFIGURATION.md → Agent SSO (token exchange)`.

Body: `{ "provider": "microsoft" | "google", "subject_token": "<IdP ID token>" }`. Response `200`: `{ "access_token", "token_type": "Bearer", "expires_in" }` — send it as `Authorization: Bearer <access_token>` to `/index`, `/mcp`, and the ticket-eligible `/nests/:nestId/*` routes.

The `subject_token` is verified for signature (provider JWKS, `RS256` pinned), issuer (exact per provider — the tenant-scoped Entra issuer or Google's), audience (your configured client id, so a token minted for another app can't be replayed), and expiry (30s tolerance); then the same `email_verified` + `oidc_allowed_domains` policy as browser login, then resolve/JIT the user (`oidc_auto_provision`) and mint. JIT **fails closed**: auto-provision with an empty domain allowlist refuses with `no_account`.

`404 disabled` unless `sso_token_exchange_enabled` **and** `mcp_signing_secret` **and** that provider's toggle are all set (a disabled server doesn't advertise the endpoint). Rate-limited per IP (`429 rate_limited`). Other codes: `400` `bad_request` / `provider_disabled` / `provider_misconfigured`, `401` `invalid_subject_token`, `403` `email_not_verified` / `domain_not_allowed` / `no_account`, `500` `server_error`.

Related `/admin/settings` fields (GET/PATCH, superadmin only): `sso_token_exchange_enabled`, `mcp_signing_secret` (**write-only** — GET returns only `mcp_signing_secret_set: boolean`), `mcp_token_ttl_seconds` (30–3600), `ms_token_exchange_enabled`, `ms_client_id`, `ms_tenant_id` (directory GUID), `google_token_exchange_enabled`, `google_client_id`. Enabling a provider is refused while `oidc_auto_provision` is on and `oidc_allowed_domains` is empty.

---

## 2. Nests

A nest = a context vault (folder of markdown documents + governance state).

### GET `/nests`
Returns owned + shared nests. Archived nests are **absent** — as they are from every other listing, the work inbox, cross-nest search and the MCP index. Each row carries `pinned` — the calling user's own bookmark (see `POST /nests/:nestId/pin`). Nests reachable through `org`/`public` visibility alone are included too and carry `discovered: true` (owned and shared rows carry `false`) — the dashboard's default *My nests* scope leaves them out.
```json
{ "nests": [{ "id": "...", "user_id": "...", "name": "...", "slug": "...", "visibility": "private", "created_at": "..." }] }
```

`?archived=1` inverts it: **only** archived nests, and only ones the caller owns (archive, restore and delete are the owner's, so nobody else has an action to take on one). Each row carries `archived_at`.

### POST `/nests`
```json
{ "name": "My Nest", "description": "optional" }
```
Response (201): `{ "nest": { ... } }`

With `NEST_CREATION=admins` (the default) only a server admin may create or import a nest; anyone else gets `403` ("Only a server admin can create nests on this server…"). The same rule covers `POST /nests/import` and the MCP `nest_create` tool. `GET /health` reports it as `nest_creation`.

### GET `/nests/:nestId`
```json
{ "nest": { ... }, "permission": "owner" | "admin" | "write" | "read" }
```
404 if caller has no permission.

### DELETE `/nests/:nestId`
Owner only. Permanent — documents, versions and governance state all go.

### POST `/nests/:nestId/archive`
Owner only (same gate as delete, license-admin caretaker branch included). Puts the nest away without deleting anything: `{ "archived": true }`.

An archived nest is capped at `read` for **everyone**, the owner included — one guard in `resolveNestAccess`, so every REST route, MCP tool and workflow gate refuses writes. It also disappears from `GET /nests`, `/me/work`, `/me/drafts`, `GET /search`, the MCP nest index, and `GET /nests/:nestId/mcp` (404 — a pinned nest id or a nest-scoped key stops answering). Its published `/p/:slug` links return the standard not-found page. Nothing is unpublished or deleted.

**Open mode is included.** `AUTH_MODE=open` grants every caller `owner` without resolving access at all, so the cap cannot reach it either; the nest middleware checks `archived_at` directly on that path — an archived nest answers `403` to anything but a `GET` (bar the lifecycle routes, which must stay open or the nest could never be restored) and `404` on its MCP transport, exactly as in key mode.

Three surfaces sit outside the `/nests/:nestId` auth chain, so the permission cap cannot reach them and each carries its own `archived_at` check: `/p/:slug` (via `getPublishBySlug`), `POST /hooks/:token` (404 while archived — a trigger hook must not keep creating agent runs in a nest that was put away), and `schedulerTick`, which skips archived nests. All three are suspended, not disabled: restoring the nest brings its links, hooks and schedules back with no re-wiring.

Archiving also drops any pending `nest_archive` deletion request for the nest — the ask has been granted, and a row left pending could not be actioned afterwards (the honour route needs write tier, which an archived nest denies everyone). A pending `nest` **deletion** request does survive archiving and cannot be honoured from the queue while archived; the owner deletes the nest directly (`DELETE /nests/:nestId` stays open to them) or restores it first.

### POST `/nests/:nestId/restore`
Owner only. `{ "restored": true }`. Puts everything back exactly as it was — same documents, versions, stewards, links.

Editors, who cannot archive directly, ask via `POST /nests/:nestId/request-deletion` with `targetType: "nest_archive"` (see *Deletion requests*). Honouring that request archives instead of deleting.

### POST / DELETE `/nests/:nestId/pin`
The caller's own bookmark on this nest: `{ "pinned": true }` / `{ "pinned": false }`. Idempotent in both directions.

**Read-tier, deliberately.** A pin changes nothing about the nest and is visible to nobody else, so any caller who can see the nest may pin it — a read-only collaborator, and someone who reaches the nest only through a single document or folder share grant, both included. It is not ungated: a caller with no access at all gets `404` (not `403`), so the endpoint can't be used to probe which nest ids exist.

Idempotent under concurrency, not just in sequence: two simultaneous pins of the same nest both answer `200` rather than one tripping the composite primary key.

Pins are per `(user, nest)` in the `nest_pins` table and cascade with the nest. Each row of `GET /nests` carries `pinned` for the calling user, and the dashboard floats pinned nests to the top of the grid under either sort.

### GET `/nests/:nestId/settings`
```json
{
  "stewardship_enabled": false,
  "allow_self_approve": false,
  "prime_only_review": false,
  "prime_tags": ["prime-document"],
  "done_tags": ["done"],
  "require_push_confirmation": false,
  "creator_is_reviewer": false
}
```

### PATCH `/nests/:nestId/settings` (admin/owner)
```json
{ "stewardship_enabled": true, "prime_only_review": true, "prime_tags": ["prime-document"] }
```

Every field is optional; only the ones present are changed.

- `allow_self_approve` — owner/admin writes publish immediately instead of drafting.
- `prime_only_review` — in a governed nest, only **prime** documents need approval; everything else self-publishes. Off by default.
- `prime_tags` — tags that mark a document prime. Accepts an array or a comma-separated string; stored and returned normalized (no leading `#`, lowercased, deduped). See `STEWARDSHIP.md → Prime documents`.
- `done_tags` — tags whose Board columns mean "done" (default `["done"]`). A **task** whose tags change to include one gets `metadata.completed_at`; removing it clears the stamp. Same input and normalization as `prime_tags`. An empty list turns completion off. Applies to future moves only — tasks already carrying the tag are not stamped.
- `require_push_confirmation` — the **Push Confirmation Gate** (see below). **Superadmin-only to SET**: a PATCH carrying this field from anyone who is not a server superadmin is refused with a per-field `403` (`{ "error": ..., "field": "require_push_confirmation" }`) and no other field in the same body is applied. Readable by anyone who can read the nest. Off by default.
- `creator_is_reviewer` — in a governed nest, whoever creates a document becomes its document-scope `reviewer` and v1 publishes immediately; later changes go through review as usual (the creator approves teammates' changes, another reviewer approves the creator's). Prime documents still draft. Future creates only. Off by default. See `STEWARDSHIP.md → Creators review their own documents`.

Turning stewardship **off** wipes stewards and pending reviews and is owner-only; the other fields are non-destructive and never change the state of anything already published.

## Push Confirmation Gate

When a nest has `require_push_confirmation` on, a document written by an agent or script — through the MCP `context_create` tool, `POST /nests/:id/nodes` with an API key, or a bulk `POST /nests/:id/publish` — is **held** as a pending record instead of applying. It lands only after a reviewer confirms it in the web UI. Superadmin-set; default off (immediate-apply, as before).

**What the gate covers.**

| Surface | Gated? |
|---|---|
| MCP `context_create` | Yes — always; MCP is an agent surface whatever it authenticated with. Returns a `PENDING_CONFIRMATION` tool error, because nothing was created. |
| `POST /nests/:id/nodes` with `Authorization: Bearer cnst_…` | Yes → `202`. |
| `POST /nests/:id/nodes` from a session cookie (a person in the web UI) | **No** — the gate holds writes nobody watched being made; the person creating a document is the one who would confirm it. |
| `POST /nests/:id/publish` (bulk) | Yes — on any credential → `202`. |
| Edits to existing documents (`context_update`, `PATCH /nodes/:id`) | **No** — use stewardship review, which is built for changes to documents that already exist. |
| `context_delete`, `context_move` | **No.** |

So the gate is a checkpoint on documents an agent *creates*, not a general write lock on the nest. Pair it with stewardship if every change needs review.

### POST `/nests/:nestId/publish`

The bulk write endpoint. Body: `{ documents?: [{ title, content, type?, tags?, scope? }], context_md? }`.

- **Ungated nest, or a whitelisted key** → applies immediately: `201 { published, context_md_updated, node_ids, skipped, failed }` (unchanged — see §8b for the full contract).
- **Gated nest, non-whitelisted credential** → held: `202` (identical body from `POST /nests/:id/nodes` when that is held)
  ```json
  {
    "status": "pending_confirmation",
    "pending_id": "…",
    "confirm_url": "/nests/:id/pending-pushes/:pid/confirm",
    "poll_url": "/nests/:id/pending-pushes/:pid",
    "message": "…",
    "expires_at": "<ISO-8601>"
  }
  ```

Requires `write`. Doc/folder grantees cannot reach it. The held payload is bounded by `MAX_PENDING_PUSH_BYTES` and expires after `PENDING_PUSH_TTL_MS` (see `CONFIGURATION.md`).

### GET `/nests/:nestId/pending-pushes?status=pending|applied|rejected|expired`

Reviewer view (owner/admin/reviewer only) of held pushes → `{ pending_pushes: [...], count }`.

### GET `/nests/:nestId/pending-pushes/:pid`

The poll endpoint. **Readable by the submitter (same key/user that pushed) OR a reviewer** — the CLI polls with the pushing key.
```json
{
  "id": "…", "status": "pending|applied|rejected|expired",
  "nest_name": "…", "doc_count": 3, "manifest": [{ "id", "title", "type", "tags" }],
  "submitter_label": "…", "submitter_email": "…", "submitter_user_id": "…",
  "created_at": "…", "expires_at": "…",
  "decided_by": "…", "decided_at": "…", "applied_node_count": 3
}
```

`manifest[].id` is the id each title will publish to — `null` when the title carries no ASCII slug, because the id is generated at apply time. It is a preview for the confirm screen's new-vs-update badge, not a promise: an id occupied by then is skipped, not overwritten.

### POST `/nests/:nestId/pending-pushes/:pid/confirm`  `{ always_allow?: boolean }`

Confirm rights: a **reviewer/owner/admin of the nest — never the submitter**. A submitter that could confirm its own push would clear the gate with one extra call using the very key being held (and `always_allow` would whitelist it permanently); `403` otherwise.

Applies the stored payload through the same apply path an immediate push uses, attributed to the **submitter**, and returns the updated record. Confirming a push that is no longer pending (already applied/rejected/expired) → `409`. `always_allow: true` whitelists the credential that pushed for future pushes to this nest: the submitter's exact API key, or for a keyless push (PromptOwl service ticket, signed-in session) all of that user's keyless pushes, but never their API keys. Revoke it from nest settings or `DELETE /push-allowlist`.

If applying throws (a busy vault, an unusable payload), the record goes back to `pending` rather than being stranded as applied-with-nothing-written; retry the confirm.

### POST `/nests/:nestId/pending-pushes/:pid/reject`

A reviewer/owner/admin, **or the submitter withdrawing its own push** — rejecting never writes. Marks the push `rejected`. `409` if not pending.

### GET / DELETE `/nests/:nestId/push-allowlist`

Reviewer-only. `GET` → `{ allowlist: [{ user_id, key_id, user_email, key_label, created_by_user_id, created_at }], count }` (`key_id: null` = all of that user's keys; `key_id: "keyless"` = their keyless pushes, labelled "PromptOwl / signed-in session"; `user_email`/`key_label` are resolved for display and null if the user or key is gone). `DELETE { user_id, key_id? }` removes one entry → `{ removed }`.

`/push-allowlist` is governance-licensed (`503` without a valid license). The `/pending-pushes` routes are **not**: `POST /publish` is unlicensed, so a lapsed license on a gated nest would otherwise hold every push at `202` with nothing able to confirm it, and the nest would stop accepting writes with no way back.

### PATCH `/nests/:nestId/visibility` (admin)
```json
{ "visibility": "public", "acknowledge_public": true }
```
- **`visibility`** is one of:
  | value | who can read without being added |
  |---|---|
  | `private` | nobody — owner, collaborators and stewards only |
  | `org` | any **authenticated** user of this deployment (a self-hosted install is one organization). Anonymous callers get nothing. |
  | `public` | anyone, including anonymous callers |
  `org` and `public` readers see **approved content only** — drafts and pending versions stay with collaborators and stewards.
  Under `AUTH_MODE=open` every caller resolves to the anonymous user, so there is no "other authenticated user" for `org` to admit: on an open-mode deployment `org` behaves as `private`. Use it on a deployment with real logins.
- **Outside-org publish guardrail.** Setting `visibility: "public"` **requires** `acknowledge_public: true`. `org` does not on a single-organization server — it stays inside the deployment, so it crosses no organizational boundary. On a **shared deployment** (`SHARED_DEPLOYMENT=true` / Settings → Features → *This server hosts several organizations* — the PromptOwl-hosted service) the deployment *is* several organizations, so `org` requires the same `acknowledge_public: true` and the `warning` names that boundary. Without the acknowledgement the request is rejected `409`:
  ```json
  {
    "error": "Publishing this nest requires acknowledgement.",
    "requires_acknowledgement": true,
    "warning": "This makes the nest readable by anyone on the internet, outside your organization."
  }
  ```
  On a shared deployment, `org` without the acknowledgement is rejected the same way, with its own warning:
  ```json
  {
    "error": "Opening this nest to the organization requires acknowledgement.",
    "requires_acknowledgement": true,
    "warning": "This server is shared: 'Organization' makes the nest readable by every account on this server, including other organizations — not just yours."
  }
  ```
  Going back to `private` needs no acknowledgement. `GET /health` reports `shared_deployment` so a client can word its own confirmation the same way.

### Headless publishing (API-only nests) (owner / admin)
Publish a **private** nest API-only and mint read-only access keys for it (what a key can reach is [above](#headless-access-keys-api-only-nests)).

| Route | Body | Result |
|---|---|---|
| `GET /nests/:nestId/headless` | — | `{ "enabled": false, "keys": [{ "id", "label", "key_prefix", "created_at", "last_used_at" }] }` — never the token |
| `PUT /nests/:nestId/headless` | `{ "enabled": true }` | `{ "enabled": true }`. `409` unless the nest is `private`. Turning it off **pauses** every key (they answer 404 until it is turned back on). |
| `POST /nests/:nestId/headless/keys` | `{ "label": "Acme Corp" }` | `201 { "key": {…}, "api_key": "cnst_…" }` — the token is returned **once**. `400` without a label (max 80 chars), `409` while headless is off. |
| `DELETE /nests/:nestId/headless/keys/:keyId` | — | `{ "revoked": true }` — the key and its identity are gone for good. `404` for an unknown key. |

Headless governs **people without a seat**: the owner, collaborators, team shares, stewards and document/folder grantees keep the access they already have (someone has to maintain the nest). The same goes for per-document publications (`/p/<slug>` links), which the owner creates deliberately one document at a time. Reader mode is display-only and grants no access, so a headless (private) nest is never readable in the public reader. `GET /nests/:nestId/headless` returns `shared_with` (collaborator + team-share + grant counts) so a client can say so before publishing. While a nest is headless, `PATCH /nests/:nestId/visibility` to `org` or `public` answers `409`. Deleting the nest deletes its access keys. Connect a key with ctx:
```bash
export NEST_KEY=cnst_…
ctx vault add my-nest --url https://<server>/nests/<nestId>/mcp --bearer-env NEST_KEY
ctx search "your question" --vault my-nest
```

### PATCH `/nests/:nestId/reader-mode` (server-admin / superadmin only)
Configure **Public Docs Reader Mode** — a clean, read-only public docs view of the nest. Superadmin-gated via `isServerAdminUserId` (license admin OR `access.yaml` super_admins ∪ the DB-granted set; the same gate as `/nests/unsynced` and `/admin/*`). A plain nest-owner/admin who is not a superadmin gets `403`.
```json
{ "enabled": true, "home_node": "welcome" }
```
- `enabled` (optional boolean) — toggle reader mode. When on, read-only callers (public/anonymous readers) get a stripped three-pane docs reader instead of the tabbed authoring UI; owners/editors/reviewers/admins keep the full UI.
- `home_node` (optional string | null) — the designated landing/hub node id. `null` (or a blank string) clears it, so the landing node resolves by convention (first node whose id/title is `welcome | index | readme | home | overview`, case-insensitive; else the synthesized Contents table). A non-string, non-null value is rejected `400`.
- At least one of `enabled` / `home_node` must be present (`400` otherwise).
- **`home_node` is a soft pointer, not validated at write time.** An id matching no node in the nest is stored as sent, and the reader falls back to the convention as if it were unset — so an API caller gets no signal that the designation missed. The reader matches on either the full node id (`nodes/welcome`) or its bare slug (`welcome`), case-insensitively; the UI picks the id from the nest's document list rather than accepting typed input, so it never sends one that resolves to nothing.

Rejections are the standard error shape:
```json
{ "error": "home_node must be a string or null" }
```

**Reader mode enforces nothing.** It is presentation only: it hides authoring surfaces from callers who are already read-only. It grants no access, gates no route, and changes no permission — who can read the nest is still decided by visibility, collaborators and stewardship.

Response (200) echoes the persisted row:
```json
{ "reader_mode": 1, "reader_home_node": "welcome" }
```
The two additive columns (`nests.reader_mode`, `nests.reader_home_node`) also surface on `GET /nests/:nestId` via the `SELECT *` nest payload.

### PATCH `/nests/:nestId/branding` (nest owner / nest admin / server admin)
Per-nest branding for the public reader (reader mode) and the nest's `/p` published pages. The body **replaces** the nest's branding; `null`, an empty body, or `{}` resets it to unbranded.
```json
{
  "site_title": "Acme Docs",
  "logo_url": "/nests/<nestId>/assets/<uuid>.png",
  "banner_url": "https://cdn.example.com/banner.jpg",
  "banner_headline": "Acme Handbook",
  "banner_subtext": "Everything we know, versioned.",
  "accent_color": "#e11d48",
  "header_bg_color": "#0f172a",
  "page_tint_color": "#fef2f2",
  "footer_text": "© Acme Corp",
  "footer_link_url": "https://acme.example.com/",
  "footer_link_label": "acme.example.com",
  "favicon_url": "/nests/<nestId>/assets/<uuid>.png",
  "hide_powered_by": false
}
```
Every field is optional. Rules (any violation → `400`, nothing saved):
- **Colors** (`accent_color`, `header_bg_color`, `page_tint_color`): `#rgb` or `#rrggbb` only; stored as lowercase `#rrggbb`. Anything else — named colors, `red; background:url(…)`, `var()` — is refused.
- **Images** (`logo_url`, `banner_url`, `favicon_url`): an image asset uploaded to **this** nest (`POST /nests/:nestId/assets` → `/nests/<nestId>/assets/<uuid>.<png|jpg|gif|webp>`, must exist), or an `https://` URL (no credentials) whose path ends in `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp`. `javascript:`, `data:`, `http:`, protocol-relative, SVG, video assets and other nests' assets are refused.
- **`footer_link_url`**: an `https://` URL.
- **Text** (`site_title` ≤ 120, `banner_headline` ≤ 120, `banner_subtext` ≤ 280, `footer_text` ≤ 280, `footer_link_label` ≤ 80): plain text, no control characters; always rendered escaped.
- **Unknown keys** are refused — there is no free-form CSS or JS.
- **`hide_powered_by`** (boolean): hides "Powered by ContextNest" in the reader and "Secured by PromptOwl · ContextNest" on `/p`. Turning it on is **server-admin only** (`403` for a nest owner/admin). A non-admin edit that omits the field keeps the stored value — a non-admin full clear (`null` / `{}`) included, which then stores `{ "hide_powered_by": true }`; a non-admin may turn it off explicitly.

Gate: the access middleware requires the `admin` tier for this resource (owner, admin collaborator, or server admin); the handler re-checks it. Editors and viewers get `403`, anonymous callers `401`.

Response (200): `{ "branding": { …normalised… } }` or `{ "branding": null }`.

**Reading it.** There is no separate GET: `GET /nests/:nestId` returns `nest.branding` (parsed and re-validated against the write rules — a stored URL that no longer passes is dropped; `null` when unbranded) in place of the raw `branding_json` column. It is therefore readable exactly by whoever can read the nest — an anonymous reader of a public nest sees it; a private nest still `404`s.

**Where it applies.** The SPA reader (read-only callers in reader mode, and an owner's "Preview as reader") uses it for the header logo + title (falling back to the server `LOGO_URL` and the nest name), the banner on the home page, accent/header/page-tint colors, footer, favicon and tab title. On `/p`, the markdown document view, the gate page and the comment shell pick up the colors, title, logo, banner and footer; **the CSP is unchanged** — uploaded images are inlined as `data:` URIs (already allowed by `img-src data:`), and external https images are not rendered there. HTML/artifact publishes are served untouched.

### GET `/nests/unsynced` (server-admin only outside open mode)
Lists folders under `DATA_ROOT` that aren't nests yet — typically dropped in by the starter CLI or copied in manually. Each entry is a sync candidate. Reflects server-side filesystem state, so in non-open mode only a server admin — the license admin or any superadmin (`access.yaml` ∪ granted; same resolution as `/admin/*`) — sees it (everyone else gets `403`).

Response (200):
```json
{
  "folders": [
    {
      "name": "nodes/architecture",
      "label": "architecture",
      "mdCount": 12,
      "sizeBytes": 48230
    }
  ]
}
```
- `name` — path relative to `DATA_ROOT` (slash-separated; pass back verbatim to `/sync`).
- `label` — leaf folder name (display only).
- `mdCount` / `sizeBytes` — totals across all `.md` files under the folder, recursive.

When a top-level dir has no markdown directly but holds subfolders that do (e.g. `nodes/architecture/`, `nodes/standards/`), each subfolder surfaces as its own card so users can sync them as separate nests.

### POST `/nests/unsynced/sync` (server-admin only outside open mode)
Converts a sibling folder under `DATA_ROOT` into a real nest. The folder's markdown is imported (same flat-layout import as `POST /nests`), governance rows are seeded, and the source folder is removed afterwards so the same content can't be synced twice.

Body:
```json
{ "name": "nodes/architecture" }
```
- `name` — required, as returned by `GET /nests/unsynced`. Travels in the body because leaf paths contain slashes that would split a path-param across route segments.

Response (201):
```json
{
  "nest": { "id": "...", "name": "architecture", "slug": "architecture", "...": "..." },
  "documents": 12
}
```
- Nest is named after the leaf segment (`nodes/architecture` → `architecture`). If that name (or its slug) collides for the user, a `" (n)"` suffix is appended so repeat syncs Just Work.
- `documents` — count of governance-registered docs.

Errors:
- `400 Invalid folder name` — empty, contains `\`, traversal segment, dot-prefixed segment, or `node_modules`.
- `400 Folder is not eligible for sync` — reserved top-level (e.g. `nests/`).
- `400 Folder has no markdown to sync` — empty folder.
- `404 Folder not found` — path doesn't exist under `DATA_ROOT`.
- `403 Only the server admin can sync folders` — non-admin in non-open mode.

Source-folder cleanup is best-effort. If `rmSync` fails (locked file etc.) the nest is still fully built; the orphan source dir just keeps showing up in `GET /nests/unsynced` until removed manually. Same admin gate exposed as MCP tools `context_unsynced_list` + `context_sync_folder` on any nest's `/mcp` endpoint.

### DELETE `/nests/unsynced/sync` (server-admin only outside open mode)
Deletes an unsynced folder outright — for leftover files the user does **not** want as a nest. No nest is created. Same guards as sync (`assertSafeFolderName` + live-nest-storage-root check, so it can never delete a real nest or escape `DATA_ROOT` via traversal) and the same admin gate.

Body:
```json
{ "name": "nodes/architecture" }
```
- `name` — required, as returned by `GET /nests/unsynced`. In the body (not a path-param) because leaf paths contain slashes.

Response (200):
```json
{ "ok": true }
```

Errors:
- `400 name is required` — missing/blank name.
- `400` — unsafe/reserved/hidden name (traversal, `nests`, dot-prefixed, `node_modules`).
- `404 Folder not found` — path doesn't exist under `DATA_ROOT`.
- `403 Only the server admin can delete folders` — non-admin in non-open mode.

### Saved boards — `/nests/:nestId/boards`
Named Board views of a nest (columns, filters, card order). A board is a view, not a copy: it stores no documents, and reordering cards never creates a document version. **Shared** boards are visible to everyone who can read the nest; **private** boards only to their creator (anyone else gets `404`). Any write+ caller can edit a shared board's name, config and position.

**GET** `/nests/:nestId/boards` (read+) — the caller's visible boards, by `position`:
```json
{ "boards": [{
  "id": "…", "nest_id": "…", "name": "Sprint", "private": false, "position": 0,
  "created_by": "<userId>", "created_by_email": "a@x.com",
  "config": {
    "dimension": "tag", "tagNamespace": "", "tasksOnly": true, "filterTags": ["launch"],
    "layouts": { "tag:": { "columnOrder": ["todo", "doing", "done"], "hiddenColumns": [] } },
    "ranks": { "tag:::todo": ["nodes/b", "nodes/a"] }
  },
  "created_at": "…", "updated_at": "…"
}] }
```
`created_by_email` is `null` for callers below write — the read tier also serves public/org visitors, and member emails stay write-tier (as with `GET /collaborators`).

**POST** `/nests/:nestId/boards` (write+) — `{ "name": "Sprint", "private": false, "config": { … } }` → `201 { "board": … }`. `config` defaults to `{ "dimension": "tag" }`.

**PATCH** `/nests/:nestId/boards/:boardId` (write+) — any of `name`, `private`, `config`, `position` → `{ "board": … }`.
- Only the creator may change `private` (`403` otherwise).
- A `config` without `ranks` keeps the stored ranks.
- `position`: integer `0`–`10000`.

**POST** `/nests/:nestId/boards/:boardId/rank` (write+) — `{ "key": "tag:::todo", "order": ["nodes/b", "nodes/a"] }` → `{ "board": … }`. Sets one column's card order, merged into the stored ranks under a row lock, so people reordering different columns don't overwrite each other. Past the size limits, the least recently ranked columns are dropped.

**DELETE** `/nests/:nestId/boards/:boardId` (write+) — the creator, or a nest owner/admin → `{ "deleted": true }`.

Limits (`400` when exceeded): 100 boards per nest; `name` ≤ 80 characters; config ≤ 256 KB; ≤ 500 layout/rank keys; ≤ 2000 ids per list, each ≤ 600 characters; `config.dimension` ∈ `folder` / `status` / `tag`. A body that isn't a JSON object → `400`. Boards are deleted with their nest.

---

## 3. Collaborators (direct nest sharing)

Separate from stewardship — this grants raw nest access. Stewardship layers governance on top.

### GET `/nests/:nestId/collaborators` (write+)
```json
{ "collaborators": [{ "id": "...", "user_id": "...", "email": "...", "permission": "read" }] }
```
Write-tier (not read) so a public nest's read tier can't enumerate member emails.

### POST `/nests/:nestId/collaborators` (write+)
```json
{ "email": "c@x.com", "permission": "read" }
```
- `permission` ∈ `read` / `write` / `admin`.
- **Inviting no longer requires admin** — any **write+** collaborator can add people, but only **up to their own level** (escalation cap). A `write` collaborator can grant `read`/`write`; only an `admin`/owner can grant `admin`. Exceeding your level → `403`. Read-only collaborators can't invite.
- Auto-creates placeholder user (`is_invited = 1`) if email unknown.

### PATCH `/nests/:nestId/collaborators/:collabId` (admin)
```json
{ "permission": "write" }
```
Changing an existing collaborator's level stays admin-only.

### DELETE `/nests/:nestId/collaborators/:collabId` (admin)
Removing a collaborator stays admin-only.

### GET `/nests/:nestId/mentionable` (read+, members only)
```json
{ "people": [{ "email": "owner@x.com", "name": "Olive Owner", "member": true }] }
```
`member` is `false` for an account offered only through `PEOPLE_SUGGEST_ALL_USERS` (not on the nest). Only members can be a card's `assignee`; the Board's picker lists non-members to owners/admins only, behind a share-the-nest step.

Everyone who can reach the nest (owner, collaborators, shared-team members, stewards, grant holders) — the roster the `@mention` pickers offer and validate against. With `PEOPLE_SUGGEST_ALL_USERS` on, every registered account follows the roster; mentioning one of them from a write+ account adds them to the nest as a `read` collaborator (see `POST /comments`).

Read-tier, because commenting is read-tier and a read-only reviewer is the person most likely to tag someone. The property `GET /collaborators` protects with its write tier is kept by a narrower rule: **you may see the roster if you are on it.** A caller who reaches the nest only through its visibility (`public`, or `org`) is not on the roster → `403`. Write+ callers pass regardless (they can read the fuller roster anyway).

### GET `/people/suggest?q=&limit=` (auth required)
```json
{ "people": [{ "email": "c@x.com", "name": "Carl Colleague", "source": "nest" }] }
```
Server-wide, not nest-scoped: the people the caller **already works with** — anyone on a nest they own or collaborate on (its owner, collaborators, active stewards) and anyone on a team they own or belong to. `source` ∈ `nest` / `team` / `directory`. For a server admin the directory is every user; `GET /auth/teammates` remains the admin-only full roster.

Scope is deliberately narrow by default, because a single server may hold several unrelated organisations: `PEOPLE_SUGGEST_ALL_USERS` (off by default, Settings → Features → People directory) widens it to every registered account, which is right for a single-company deployment and wrong for a shared one. A server admin always sees every account.

`q` filters on name or address (substring, case-insensitive); `limit` caps the list (default and max 20). Suggestions are a convenience for the add-a-person pickers — an address that appears nowhere here is still valid to submit (that is how you invite someone with no account yet), and the add itself re-checks permission and the escalation cap.

---

## 3a. Share grants (one document / one folder)

A **grant** gives one person access to a **single document** or **everything under one folder**, without making them a nest-wide collaborator. Access only — a grant is not stewardship and confers no approval rights.

Resolution: a grant covers a node when the node id equals `target` or sits under `target + "/"`. `write` outranks `read` when several grants overlap. A grantee with no nest-wide permission sees **only** the nodes their grants cover — `GET /nests/:id/nodes` is filtered to them.

**Discovery.** A grantee finds the nest by logging in: it is listed in `GET /nests`, and `GET /nests/:id` returns it, both with `permission: "read"`, `roles: ["viewer"]`, and `grant_only: true`. The list card is scoped to their slice, not the nest — `document_count` counts only the documents their grants cover, and `collaborator_*` / `steward_*` come back empty, so being shared one document never reveals how large the nest is or who else works in it. Grant-only nests deliberately do **not** enter the work inbox or `/stats`: those are governance surfaces over documents the grantee can't read.

The nest routes report a grantee as a `read` caller so the nest resolves instead of 404ing, but this buys no authority: rename, delete, import, and settings-write still require `owner`/`admin`, and the remaining nest paths (`/settings`, `/stewards`, `/collaborators`, `/review-queue`, `/feed`, …) are not on the grantee's middleware allow-list at all — they answer `404`. A grantee's reachable surface is exactly: `GET /nests/:id`, `GET /nests/:id/nodes` (filtered), the granted nodes themselves, and the read-query routes (`/query`, `/search`, `/context`, `/export`), each scoped to their grants. Note `resolveNestPermission` still returns `none` for them — that is what routes them into the per-node grant checks.

Managing grants is **owner / nest admin / server admin** (`canManageStewards` — same authority as the steward roster). Everyone else gets `403`.

### GET `/nests/:nestId/grants`
```json
{ "count": 1, "grants": [{ "id": "...", "target_type": "document", "target": "nodes/win-loss-log", "user_id": "...", "email": "guest@x.com", "role": "read", "granted_by": "owner@x.com", "created_at": "..." }] }
```
The whole nest's sharing roster, annotated with the grantee's email.

### POST `/nests/:nestId/grants`
```json
{ "target_type": "document", "target": "nodes/win-loss-log", "email": "guest@x.com", "role": "read" }
```
- `target_type` ∈ `document` / `folder`; `role` ∈ `read` / `write` (default `read`).
- `target` is a node id (`nodes/win-loss-log`) or a folder prefix (`nodes/gtm/deals`).
- A folder target must name a **subfolder**: a bare `nodes` root would match every node and silently share the whole nest → `400`.
- Re-granting the same `(target_type, target, user)` updates the role rather than duplicating.
- Auto-creates a placeholder user (`is_invited = 1`) if the email is unknown, same as collaborator invites.
- `201 { grant }`.

### DELETE `/nests/:nestId/grants/:id`
`{ "deleted": true }`, or `404` if the grant isn't in this nest.

Moving a document carries its **document** grants to the new id; deleting it drops them. **Folder** grants pin to a path, so a moved document leaves one share and joins another. Grants do not travel in a nest export bundle.

Agent equivalent: the `context_grant` MCP tool takes the same four fields in one call (see §MCP and `/llms.txt`). In the UI: **Share this document** on a document's ⋯ menu, and the share icon on a folder row in the nest view.

---

## 3b. Teams (group sharing)

A **team** is a reusable, owner-managed group of users. Each member carries a
**role** (`admin` / `editor` / `viewer`) set on the membership and applied
uniformly on every nest the team is shared to. Sharing a team onto a nest
records a `{teamId, teamName}` ref on `nests.shared_teams` (no join table);
every member then resolves to their own role there, combined highest-wins with
any direct collaborator / steward grant.

Member role → access mapping:

| role | nest permission | governance role |
|------|-----------------|-----------------|
| `viewer` | `read` | viewer |
| `editor` | `write` | editor |
| `admin` | `admin` | admin |

Sharing a team whose members carry a governance role (`viewer`/`editor`) turns
`stewardship_enabled` on for the nest (parity with assigning an individual
steward). An `admin`-only team is collaborator-style and does not.

### Team management (global)

Auth is the shared session/key auth. Management is gated by the caller's role on
the team (the server/license admin may manage any team): **add people** =
editor/admin members + owner (escalation-capped — can't grant above your own
role); **rename / change-role / remove** = admin members + owner; **delete** =
owner only. Unregistered member emails mint a placeholder user (`is_invited = 1`),
same as collaborator/steward invites.

- **POST `/teams`** — `{ "name": "Platform" }` → `201 { team }`. Any user may
  create a team (they become its owner).
- **GET `/teams`** — teams the caller owns **or is a member of** → `{ teams: [...] }`.
  Each member is enriched with `registered` (real account vs invited placeholder)
  and the team with `owner_email`.
- **GET `/teams/:teamId`** — owner, a member, or the server admin may view →
  `{ team: { id, name, owner_id, owner_email, members: [{ userId, email, role, registered }], ... } }`.
- **PATCH `/teams/:teamId`** — `{ "name": "..." }` rename (admin/owner). Also
  refreshes the cached `teamName` in every nest that shares this team.
- **DELETE `/teams/:teamId`** — delete (owner/server-admin); strips the team's
  ref from every nest's `shared_teams`.
- **POST `/teams/:teamId/members`** — `{ "email"|"user_id", "role" }` add a
  member (`role` ∈ `admin`/`editor`/`viewer`) → `201 { team }`. Editor/admin
  members + owner, capped to the caller's own role. Duplicate member → `409`;
  invalid role → `400`; above your level → `403`.
- **PATCH `/teams/:teamId/members/:userId`** — `{ "role": "..." }` change role
  (admin/owner, capped).
- **DELETE `/teams/:teamId/members/:userId`** — remove a member (admin/owner);
  their access to every shared nest is revoked immediately (no per-user rows).

A team-shared nest also appears on each member's dashboard (`GET /nests`) with
their role, so they can open it and act per their role.

### PromptOwl team import (`/teams/promptowl/*`)

Copy the teams the caller owns in PromptOwl into this server. Both routes are
capped at 10 requests per IP per 15 minutes.

**Only a PromptOwl sign-in can import.** Signing in with PromptOwl parks the
device token in an httpOnly cookie (`cnst_po_token`, `Path=/teams`, lifetime of
the session), and these routes read it **from there and nowhere else** — a token
in the request body is ignored, so a user who signed in another way (SSO, OIDC,
password) cannot import by supplying one. Hiding the UI is the other half of
this rule, not the enforcement.

The token is **never written to the database**: PromptOwl hands it over exactly
once, and a self-hosted server holding live credentials for someone else's SaaS
is a far worse liability than a cookie that dies with the session. `Path=/teams`
means the browser only attaches it to these routes. It is scoped upstream to
`user:read` + `teams:read`, so it cannot act as the user in PromptOwl (no agent
chat, no credit spend) even if it leaks.

Sign-in also sets `cnst_po_session=1` — a readable, secret-free marker so the
SPA knows whether to offer the PromptOwl Teams tab. Both cookies are cleared on
logout.

**`428 Precondition Required`** with `{ code: "promptowl_connect_required" }`
means "no PromptOwl session — sign in with PromptOwl". It is deliberately **not**
`401`: the caller is authenticated here, and a `401` would read to the SPA as an
expired session and bounce them to the login screen. The same 428 is returned
when PromptOwl rejects the token (revoked upstream), and the cookie is cleared
so a dead token isn't replayed forever.

An imported team carries `source: "promptowl"` and `external_id` (its PromptOwl
id); a team created here has `null` for both. `(owner_id, source, external_id)`
is the import key — a re-import updates that same team rather than duplicating
it, and survives a rename on either side. Two users importing the same PromptOwl
team each get their own local team.

- **GET `/teams/promptowl`** — `{ teams: [{ id, name, owned, your_role, source,
  enterprise, updated_at, members: [{ email, role }] }] }`. Read-only. Returns
  every team the caller owns **or belongs to** in PromptOwl; `your_role` is
  their role on it there. No PromptOwl session → `428`; unreachable PromptOwl →
  `400`.
- **POST `/teams/promptowl/sync`** — `{ "team_ids": [...] }` →
  `{ results: [{ team_id, external_id, name, created, added, updated, removed }] }`,
  where `added`/`updated`/`removed` are member emails. A `team_id` the caller has
  nothing to do with upstream → `400` (unrelated and nonexistent teams are
  refused identically, so the error can't be used to probe which ids exist).

  **Importing requires `Owner` or `Editor` upstream** → otherwise `403`, and the
  whole batch is refused before any writes. The local copy is owned by the
  importer — free rein to rename it, rewrite its roster, and share it onto a
  nest. A view-only member of the upstream team holds none of that and must not
  gain it by copying the team here; that's the same escalation
  `shareTeamWithNest` already refuses. PromptOwl's `Viewer`, its default `User`,
  and any unrecognized role all count as no authority.

  **PromptOwl wins.** The local roster is reconciled to match: roles are reset
  and members no longer in the PromptOwl team are **removed**, including ones
  added here by hand. Roles map `Owner→admin`, `Editor→editor`, `Viewer→viewer`,
  and `User`→`viewer` (as does any unrecognized role — an unknown role must never
  widen access). The importer is the local team's owner and is not written into
  the roster. Unregistered member emails mint placeholders exactly as
  `POST /teams/:teamId/members` does.

### Nest team-share (`/nests/:nestId/teams`)

- **GET** `(write+)` — teams shared onto the nest, enriched with members:
  `{ teams: [{ teamId, teamName, members: [{ userId, email, role }] }] }`.
  Write-tier (like the collaborator roster) so a read tier can't enumerate emails.
- **POST** `(admin)` — `{ "team_id": "..." }` share a team → `201 { teams }`.
  Already shared → `409`. The caller must also be **editor+ on the team**
  (editor/admin/owner, or server admin); a view-only member sharing → `403`, so
  a viewer can't project a whole team onto a nest they own.
- **DELETE `/nests/:nestId/teams/:teamId`** `(admin)` — unshare → `{ teams }`.

---

## 4. Nodes (documents)

`nodeId` = relative path without `.md`, e.g. `nodes/api-design`.

### GET `/nests/:nestId/nodes`
Lists all readable docs.
- When `stewardship_enabled = true`, list is filtered by `filterAccessible` — non-steward users only see what they're assigned to.

Optional query params, applied before the per-node enrichment:

| Param | Notes |
|---|---|
| `type` | Node type. A doc with no `type:` counts as `document`. |
| `tag` | Leading `#` optional, case-insensitive. |
| `status` | `draft` \| `pending_review` \| `approved` \| `published` \| `rejected`; aliases normalized. Retired docs stay in this listing regardless — here they are unpublished docs their stewards may still act on. |
| `approved_only` | `1`/`true` — only docs with an approved version, each served at that version rather than the live file. The view a public nest gives a stranger, so an owner can preview what going public would expose. |
| `limit` | Max nodes to return. A non-numeric value is ignored, not an error. |
| `folder` | Present (even as `""`) → that one folder level only, for a lazily-expanded document tree. Absent → the whole nest. |
| `content` | `1`/`true` — include document bodies. **Off by default:** the listing is served from the nest's document index, which holds metadata only, so bodies cost a vault crawl and are opt-in. |
```json
{
  "count": 1,
  "nodes": [{
    "id": "nodes/foo",
    "title": "Foo",
    "type": "document",
    "tags": ["#api"],
    "status": "draft" | "pending_review" | "approved" | "rejected",
    "version": 1,
    "author": "creator@x.com",
    "collaborators": ["editor@x.com", "grantee@x.com"],
    "created_at": "...",
    "updated_at": "...",
    "content": "# md body — only with ?content=1",
    "schedule": "0 6 * * *"
  }]
}
```
- `schedule` is present only on runnable nodes (`type` `agent`/`skill`); omitted otherwise.
- `author` = the doc's creator (frontmatter author, else the first version's author); `null` for old imports with neither. `collaborators` = distinct version authors ∪ document-scope grant holders, minus the author, sorted. Both also appear on the single-node GET below.
- Public readers (callers who reach a `visibility: public` or `visibility: org` nest without being its owner or a collaborator) do **not** receive `collaborators` — the field is omitted, and `author` falls back to the frontmatter value only, never to a version author. The roster is treated as private to the nest's members, like draft content.

### POST `/nests/:nestId/nodes`
```json
{
  "title": "Foo",
  "content": "# Foo\n\nbody...",
  "tags": ["api", "v2"],
  "type": "document",
  "scope": "team",
  "status": "draft",
  "folder": "gtm/deals",
  "schedule": "0 6 * * *",
  "client": { "agent": "claude-code", "session_id": "s-9f2" }
}
```
- Slug derived from title → `nodes/<slug>`.
- Optional `folder` (string) nests the doc → `nodes/<folder>/<slug>`. Each `/`-separated segment is slugified independently (so `../` or absolute paths can't escape the vault); empty segments drop. A leading `nodes/` segment is stripped, so `nodes/gtm/deals` and `gtm/deals` mean the same folder. Max 8 levels deep; each segment (and the title slug) max 100 chars — otherwise `400`.
- `409` when the derived id is already taken (same folder + same title). The existing document is left untouched — update it, or pick another folder or title. The same title in a *different* folder is still allowed here; MCP `context_create` is stricter and refuses it (see [§9 MCP](#9-mcp)).
- Optional `schedule` (free-form cron/interval string, opaque to the server) — **only valid when `type` is `agent` or `skill`**; sent on any other type → `400`. Stored in frontmatter metadata and echoed back on every node response. See [§9 `GET /runnables`](#get-nestsnestidrunnables-read).
- Optional `prime` (boolean) flags the document as **prime** — it then always requires steward approval, whoever writes it. Owner/admin only; any other caller sending the field gets `403`. Omit to inherit from the nest's `prime_tags`; `false` exempts this document from an otherwise-prime tag. Echoed back on every node response as `prime` (absent when inherited). See `STEWARDSHIP.md → Prime documents`.
- If stewardship enabled → status defaults `draft`. Else `approved`.
- Optional `client` — caller attribution, recorded on the version this create seals. See [Caller attribution](#caller-attribution-client).
- Auto-syncs tag index for steward resolution.

Response (201): `{ "node": { ... }, "stewards": [...] }`.

**`202` on a gated nest.** If the nest has `require_push_confirmation` on and this call arrived on a **non-whitelisted API key**, nothing is created: the document is held and the response is the `202 pending_confirmation` body documented under [Push Confirmation Gate](#push-confirmation-gate). A session-cookie caller (a person in the web UI) is never held. Poll `poll_url` for the outcome; the document exists only once `status` reads `applied`.

### GET `/nests/:nestId/nodes/:nodeId`
Full node content. 403 if no steward access (when stewardship on).
Add `?format=markdown` to receive `text/markdown` (frontmatter + body) instead
of JSON — see [§8 export](#get-nestsnestidexportformatmarkdown--llm-pointed-plain-text-view).

**Direct raw fetch** — `?format=raw` returns the node **body** as plain text
(no JSON envelope, no synthesized frontmatter):

| Param / header | Effect |
|---|---|
| `?format=raw` | Raw node body as text; Content-Type per node type (table below). |
| `Accept: text/markdown` (header) | Same as `?format=raw` when no `format` param is present. An explicit `format` param always wins (`?format=markdown` keeps the frontmatter+body export; any other `format` value keeps JSON). Exact media-type match only — `text/*` / `*/*` do not trigger it. Matching is presence-based and deliberately ignores q-values: `text/markdown;q=0.1` still triggers raw. |
| `?frontmatter=1` | Only meaningful with raw: prepends the node's YAML frontmatter block exactly as stored, above the body. |

Content-Type by node `type`:

| Node type | Content-Type |
|---|---|
| `document`, `agent`, `skill` (and any other/unset type) | `text/markdown; charset=utf-8` |
| `artifact` | `text/html; charset=utf-8` |
| `tool`, `table` | `text/plain; charset=utf-8` |

Access is identical to the JSON GET — same middleware, grants, and
public-reader semantics. Public readers get the **approved snapshot** body
(and, with `frontmatter=1`, that snapshot's stored frontmatter); callers
without read access get the same 403/404 JSON error as the JSON GET, never
body bytes. Without `format`/`Accept` the response is unchanged JSON.

### POST `/nests/:nestId/nodes/:nodeId/revert`
Restore an earlier version by writing its content as a **new** version (history is preserved).
```json
{ "targetVersion": 3 }
```
Response: `{ "ok": true, "version": <new>, "node": { ... } }`. `400` without a valid `targetVersion`; `404` if that version doesn't exist. Only **sealed** versions can be reverted to — a draft revision is not in the version chain (see below).

### POST `/nests/:nestId/nodes/:nodeId/discard`

Throw away the unreviewed work on a document. No body.

Response: `{ "ok": true, "deleted": <bool>, "version": <sealed|null> }`.

Two outcomes, and which one you get depends on the document:
- It was published before → the file goes back to that version and the draft rows above it are dropped. `deleted: false`, `version` names the version restored.
- It was **never** published → there is nothing to fall back to, so the document is deleted, exactly as `DELETE /nodes/:nodeId` would. `deleted: true`.

Costs no version either way. A draft save is never appended to the engine's history chain — that chain is append-only and hash-linked, so anything recorded in it can never be taken back. Unreviewed work lives in the file plus one governance row; a version is sealed when the draft is **submitted for review**, and again when it is published. That is what makes discarding cheap, and why `ctx verify` is unaffected by it.

`423` while a review is pending — discarding would pull the document out from under the reviewer. Reject the review first. `400` if the sealed version can no longer be reconstructed from the chain (delete the document instead).

### PATCH `/nests/:nestId/nodes/:nodeId`
Headers (optional): `X-Base-Version: 3` — server returns 409 on conflict.
```json
{
  "title": "...",
  "content": "...",
  "tags": ["..."],
  "changeNote": "fixed typo",
  "schedule": "0 7 * * *",
  "client": { "agent": "claude-code", "session_id": "s-9f2" }
}
```
Requires nest write permission.
- `client` — caller attribution, recorded on the version this edit seals. See [Caller attribution](#caller-attribution-client).
- `schedule` — runnable types (`agent`/`skill`) only; sent for any other type → `400`. Send `""` to clear it.
- `type` — re-type the node in place (the editor's "Turn into…"): `document`, `artifact`, `table`, `agent`, `skill`, `tool`, or any other engine type. Same gate as create — the artifact/table feature flags and the accepted set (`400` otherwise). The body is kept as-is. Converting to `skill` defaults the trigger from the title; converting away from a runnable type drops its `schedule`.
- `prime` — owner/admin only (`403` otherwise). `true`/`false` set the document-scope flag, `null` clears it back to tag/nest inheritance. An edit that makes the document prime is itself gated, so it lands as a draft awaiting approval.

### DELETE `/nests/:nestId/nodes/:nodeId`
Write permission. Hidden in UI for reviewer/viewer; server still enforces.

A node with a pending review is frozen — `423` — for callers who can't clear that review. Approvers (nest owner, admin, assigned reviewer) go through: they can reject and then delete, so the lock only cost them a round trip. Same rule on `POST /nodes/:nodeId/move`; editing under review is unchanged (still author-only).

Purges everything keyed to the node id — version history, review requests, the approved-version pin, tag index, annotations and their comments, review comments, watchers, schedules, trigger hooks, workflow edges, document-scoped stewards and document grants — and leaves a deletion tombstone for `GET /changes`. Node ids derive from titles, so a later document can land on the same id; it must inherit none of the old one's readers, reviewers or history. Run traces are kept: they record what happened, not what exists. `POST /nests/:nestId/nodes/:nodeId/move` carries that same set to the new id instead of dropping it (folder grants excepted — they cover a path prefix, so a moved doc leaves one share and joins another).

### POST `/nests/:nestId/nodes/pdf`
Upload a PDF as a governed `pdf` document. Multipart: `file` (required), optional `title` (default: the file name), `folder`, `tags` (repeat the field or comma-separate), `nodeId`, `changeNote`. Write permission (nest-scope steward editors too, as for `POST /nodes`).

The engine's `context_import_pdf` extracts the text — the node body, one `<!-- page N -->` marker per page — and stores the PDF beside the node as `<id>.pdf`, bound by sha256 in the node's `pdf:` frontmatter block. Governance is exactly a create's: in a governed nest the upload lands as a draft (or publishes when a create by that person would); without stewards it publishes.

- `nodeId` of an existing `pdf` node → the PDF is replaced as a **new version** of that node (same review lock, draft/publish rule and version rows as `PATCH`). The prior binary stays in history. Identical bytes are a no-op. A replace is two engine writes (stage the new PDF, then the same update/publish a text edit makes); if the second fails, the node's previous file and PDF are put back before the error is returned.
- `400` — no `file`, not a PDF (checked by the `%PDF-` header, not the extension), an encrypted/unreadable PDF, or `nodeId` names a node that is not a pdf. `413` — larger than `PDF_MAX_MB` (default 25 MB). Nothing is written on any refusal.
- A PDF with no text layer (a scan) imports with an empty body and `pdf.text_layer: false`; there is no OCR.
- Returns `201` `{ node, version, stewards? }` on create, `200` `{ node, version }` on replace. `node.pdf` is the `pdf:` block (`file`, `sha256`, `bytes`, `pages`, `text_layer`, `extractor`, `extractor_version`, `extracted_at`).

A pdf node's text is read-only: `PATCH` with a `content`/`append` that changes it → `409` (re-upload instead; echoing the stored body back is accepted). A pdf node can't be converted to another type or another type to `pdf` (`400`), can't be moved to another folder yet (`400`), and `POST /nodes` with `type: "pdf"` → `400`. `POST …/revert` re-imports the target version's PDF; `POST …/discard` restores the sealed version's PDF (the response carries a `warning` if that binary can't be restored); `DELETE` removes the binary with the node.

### GET `/nests/:nestId/nodes/:nodeId/pdf`
The PDF binary, gated exactly like `GET /nodes/:nodeId`. A public reader (or `?approved_only=1`) always gets the **approved** version's bytes — never a draft's — whatever version is asked for; other readers get the current working copy, or `?version=N`. Every response is verified against the sha256 its version records (a mismatch is refused, not served).

Headers: `Content-Type: application/pdf`, `Content-Disposition: inline; filename="<slug>.pdf"` (`?download=1` → `attachment`), `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-cache`, and an `ETag` of the sha256 (`If-None-Match` → `304`). `404` when the node has no such version or no approved version (public). An id that is not a pdf node falls through to the node route, so a document whose own id ends in `/pdf` still reads.

### POST `/nests/:nestId/assets`
Multipart upload (field `file`) of an image or video referenced from documents. Write permission.

Supported types and per-type size caps:

| Type | Extensions | Max size |
|------|-----------|----------|
| Image | `png`, `jpg`/`jpeg`, `gif`, `webp` | 10 MB |
| Video | `mp4`, `webm` | 100 MB |

SVG is deliberately not accepted (stored-XSS surface). Returns `201` with `{ file, url, markdown }` — `markdown` is a ready-to-paste reference: `![alt](url)` for images, the bare asset URL for video (the read view renders same-origin asset video URLs as a player).

### GET `/nests/:nestId/assets/:file`
Serves the asset bytes with the correct content-type and immutable caching. Read permission. Only server-minted `<uuid>.<ext>` names are accepted.

### Watchers — GET/POST/DELETE `/nests/:nestId/nodes/:nodeId/watchers`
"Tag a person to this node." Watchers of a document are notified when it changes or lands for review; watchers of an agent hear when its output does. `POST` body `{ email }` (write); `DELETE …/watchers?email=` (write). All three return `{ "watchers": [ … ] }`. Watchers follow a `move` and are purged by a `DELETE` of the node.

---

## 5. Stewardship

### GET `/nests/:nestId/stewards`
```json
{ "stewards": [{
  "id": "...",
  "userEmail": "rev@x.com",
  "userId": "...",
  "scope": "document" | "tag" | "nest",
  "nodePattern": "nodes/foo" | "<nestId>" | null,
  "tagName": "api" | null,
  "role": "editor" | "reviewer" | "viewer"
}] }
```

### POST `/nests/:nestId/stewards`
**Two shapes accepted.**

**Legacy single-user (what the UI sends):**
```json
{
  "scope": "document",
  "email": "rev@x.com",
  "role": "reviewer",
  "nodePattern": "nodes/foo"
}
```

Field selection by scope:
| scope | required field | meaning |
|---|---|---|
| `document` | `nodePattern` | exact node id |
| `tag` | `tagName` | bare tag, no `#` |
| `nest` | — | covers every node in the nest |

**Multi-user shape:**
```json
{
  "scope": "tag",
  "tagName": "api",
  "users": [
    { "email": "r1@x.com", "role": "reviewer" },
    { "email": "r2@x.com", "role": "editor" }
  ]
}
```
For document scope use `documentId`; for nest no target. Sending `scope: "folder"` returns **400** — folder scope was removed.

**Side effects on POST:**
1. Auto-flips `nests.stewardship_enabled = 1` on the nest.
2. Auto-creates `users` row with `is_invited = 1` if email unknown.
3. Auto-inserts `nest_collaborators`: `editor → write`, `reviewer | viewer → read`.
4. Idempotent — duplicate `(nest, scope, target, email)` returns the existing row.

Response (201): `{ "stewards": [...] }` (multi) or `{ "steward": {...} }` (legacy single).

### DELETE `/nests/:nestId/stewards/:stewardId`
Soft-removes (`is_active = 0`).

### POST `/nests/:nestId/stewards/sync`
Re-imports stewards from `<nest>/.context/stewards.yaml` if present.
Response: `{ "synced": N }`.

### GET `/nests/:nestId/nodes/:nodeId/stewards`
Resolved stewards for one node (priority `document(1) > tag(2) > nest(3)`).
```json
{
  "nodeId": "nodes/foo",
  "stewards": [{
    "email": "rev@x.com",
    "role": "reviewer",
    "scope": "document",
    "source": "document: nodes/foo",
    "priority": 1
  }],
  "fallbackToOwner": false,
  "ownerEmail": null
}
```

### GET `/nests/:nestId/nodes/:nodeId/can-access`
`{ "allowed": true, "reason": "...", "role": "reviewer" | null }`

### GET `/nests/:nestId/nodes/:nodeId/can-approve`
Same shape. Allowed iff the caller has a matched steward row with `role: reviewer` covering this node.

### GET `/nests/:nestId/nodes/:nodeId/can-edit`
Same shape. Reflects nest collaborator permission OR steward `editor` role.

---

## 6. Review workflow

### POST `/nests/:nestId/nodes/:nodeId/submit-review`
```json
{ "note": "ready for review", "priority": "low" | "normal" | "high" | "urgent" }
```
Sets node status → `pending_review`. UI locks editing.

### POST `/nests/:nestId/nodes/:nodeId/approve`
```json
{ "note": "lgtm", "override": false }
```
- Server checks caller has a steward row covering this node with `role = 'reviewer'`. **403 `Insufficient permissions`** otherwise.
- Nest middleware allows `read`-perm collaborators through this path; per-row stewardship enforces real authorization.
- `override: true` only honored for the super-admin license owner.

Response: `{ "review": { "id": "...", "status": "approved", ... } }`.

### POST `/nests/:nestId/nodes/:nodeId/reject`
```json
{ "note": "needs change X" }
```
`note` required. Same permission gating as approve (`role = 'reviewer'`).

### POST `/nests/:nestId/nodes/:nodeId/cancel-review`
Cancels the pending review. Returns node to `draft`.

Allowed for the person who submitted it (withdrawing your own submission) and
for anyone with approve rights on the node. Anyone else gets 403 — read access
to the nest alone is not enough.

### GET `/nests/:nestId/external-edits`
Query: `?refresh=true` to rescan the disk first; `?count=1` to get the total only.

Pending external (on-disk) edits awaiting approval, newest first. The list is computed by scanning every document's suggestions, so `?count=1` saves bytes (`{ "total": n }`), not server time — the UI uses it for the tab badge.
```json
{ "entries": [{ "suggestion_id": "...", "document_id": "nodes/foo", "source": "out-of-band-edit", "detected_at": "...", "actor": "..." }], "total": 1 }
```

### GET `/nests/:nestId/review-queue`
Query: `?status=pending&limit=50&offset=0`

Returns ALL reviews for the nest (server does not gate by reviewer scope).
```json
{
  "requests": [{
    "id": "...",
    "nodeId": "nodes/foo",
    "version": 3,
    "requestedBy": "author@x.com",
    "requestedAt": "...",
    "status": "pending",
    "priority": "normal",
    "requestNote": "..."
  }],
  "total": 1
}
```

**UI filtering** (recent change) — the React layer hides:
- Items the caller submitted (separation of duties).
- Items outside the caller's steward scope. **No admin/owner bypass.**

So Postman will see more rows than the UI; that's expected.

### POST `/nests/:nestId/review-queue/bulk`
Body: `{ "nodeIds": ["nodes/a", "nodes/b"], "action": "approve" | "reject", "note": "..." }`

One decision applied to several pending documents. Each item runs through the
same `approve` / `reject` as the per-document routes, so permission resolution,
state validation, history and notifications are identical — this is a wrapper,
not a second governance path. A rejection still requires `note`, and there is no
override: forcing past a refusal stays a per-document decision.

Partial success is the normal outcome, so the call returns `200` with a per-item
report rather than failing the batch:

```json
{
  "action": "approve",
  "succeeded": 2,
  "failed": 1,
  "results": [
    { "nodeId": "nodes/a", "ok": true },
    { "nodeId": "nodes/b", "ok": true },
    { "nodeId": "nodes/c", "ok": false, "error": "Approvals go to assigned reviewers…" }
  ]
}
```

Duplicate ids collapse. Up to **50** ids per call; an empty or oversized
selection is refused up front (`400`) rather than silently truncated.

### GET `/nests/:nestId/nodes/:nodeId/reviews`
Full review history for a node.

### POST `/nests/:nestId/nodes/:nodeId/request-deletion`
Body: `{ "reason": "superseded by the new runbook" }` (required).

**Editor permission.** Asking for a deletion is an editor's act: a viewer of any kind — a `read` collaborator, a viewer steward, someone holding a `read` share grant — gets `403`. What counts as an editor is the same three paths that let someone change the document: nest-wide `write`, an editor steward row covering it, or a `write` share grant on it. Deleting outright stays higher still (owner/admin, or the document's own author), so an editor who spots dead content flags it rather than removing it. `404` comes first for a node the caller can't read or that doesn't exist, so the gate is never an existence oracle.

A flagged node is **not** locked or under review; it stays editable and never appears in the review queue. One pending flag per node (`409` on a second). Returns `201 { request }`.

`GET /nests/:nestId/nodes/:nodeId` carries `deletionRequest` — the node's latest flag (`{ status, requestedBy, reason, resolvedBy?, resolutionNote?, resolvedAt? }`) or `null`. `pending` lets a client badge the document and drop its request affordance rather than discovering the `409`; `declined` carries the resolver's note, which is how the person who asked learns the verdict.

### POST `/nests/:nestId/request-deletion`
Body: `{ "targetType": "folder" | "nest" | "nest_archive", "target": "api/limits", "reason": "..." }` (`target` ignored for both nest targets).

`nest_archive` asks for the nest to be **archived** rather than destroyed — same table, same queue, same reviewers and the same decline/withdraw paths as any other request; only what honouring it does differs. The two nest targets are independent pending rows, so one of each can be open at once.

Editor permission, same as the per-document route — with one difference: a steward editor needs **nest** scope here, since a row scoped to one document is no mandate over a folder or the whole nest. A folder target is normalized (`/nodes/api/limits/` → `api/limits`) so two people flagging the same folder collide on one pending request rather than raising two; `404` if no documents live under it. One pending flag per (nest, target type, target).

### POST `/nests/:nestId/delete-folder`
Body: `{ "folder": "api/limits" }`. **Owner/admin only** — a folder delete is many document deletes at once, so it sits at the nest-management tier, not `write`. Deletes every document under the prefix (sub-folders included) through the normal per-node path, so each gets its review-lock check, row purge and tombstone. Returns `{ deleted, nodeIds }`. Non-admins use the request flow above.

Folders are not stored objects — they exist only as segments of the node ids beneath them, so deleting a folder *is* deleting its documents.

### GET `/nests/:nestId/deletion-requests`
Query: `?status=pending|declined|all` (defaults to `pending`). `all` returns both states newest-first — one call for a client that shows the queue and badges declined nodes.

```json
{
  "requests": [{
    "id": "...",
    "nodeId": "nodes/foo",
    "title": "Foo",
    "requestedBy": "reader@x.com",
    "reason": "superseded",
    "status": "pending",
    "createdAt": "..."
  }],
  "total": 1
}
```

### POST `/nests/:nestId/deletion-requests/:id/delete`
Honours the request — write permission, the same tier `DELETE /nodes/:nodeId` requires (including its `423` review lock). Branches on the request's `targetType`: a document goes through `deleteNode`, a folder through the bulk delete above, a nest through `deleteNest`, and `nest_archive` through `archiveNest` (nothing is deleted; the nest can be restored).

Both **nest** targets additionally require owner/admin: acting on a whole nest is the owner's call (`DELETE /nests/:id` and `POST /nests/:id/archive` enforce that), and honouring a request must not be a way around it — a write-tier collaborator gets `403`.

An honoured request always leaves the queue: a document's row is purged with its other node-keyed rows, a nest's cascades with the nest, and a folder's — which is neither — is dropped explicitly.

Raising a request notifies the nest owner + owner/admin collaborators: a `/me/work` inbox row, the `deletion_requested` connector event (Slack/Teams/webhook), and a direct email. Resolving it — either way — notifies the requester the same way (`deletion_deleted` / `deletion_declined`). All delivery is best-effort; a notification failure never fails the action.

`GET /me/work` returns these alongside reviews as items with `type: "deletion"`, carrying `reason` and `request_id`. They land in `items` only for nest owners/admins (the tier that can delete) and in `waiting` for whoever raised them.

### POST `/nests/:nestId/deletion-requests/:id/decline`
Body: `{ "note": "still referenced by onboarding" }` (required). Write permission. Keeps the node and the row, recording who declined and why. `404` once the request is no longer pending.

### GET `/nests/:nestId/agent-activity`
Query: `?scope=agents|all&agent=<name>&limit=50&offset=0` (scope defaults to `agents`, limit caps at 200, offset caps at 10 000)

What **agents did to this nest**, newest first: every write whose recorded `client` names an agent (§9.4 attribution — the MCP `initialize` handshake's client name, the API key's label, or a caller-sent `client.agent`), plus deletions. `scope=all` includes changes with no agent (a person in the web UI); `agent=` narrows to one agent. Built from `node_versions` and the `node_deletions` tombstones — no separate log. System auto-publish rows are left out. License-gated like `/feed`.

Owners, admins and reviewers only: items are limited to documents the caller could undo. Deletions show only to nest-wide owners/admins/reviewers. An editor or viewer gets `items: []`.

Each item carries an `undo` verdict: `available`, `effect` (`restore` | `discard` | `delete`), `restoreTo` for a restore, or a `reason` when it can't be undone. Reasons include: a newer change exists on the document, the change is awaiting review, or the entry is a deletion.

```json
{
  "items": [
    {
      "id": "nodes/pricing@v2",
      "kind": "update",
      "nodeId": "nodes/pricing",
      "title": "Pricing",
      "version": 2,
      "status": "published",
      "actor": "owner@x.com",
      "agent": "hootie",
      "client": { "agent": "hootie" },
      "at": "2026-09-28T01:00:00.000Z",
      "undo": { "available": true, "effect": "restore", "restoreTo": 1 }
    },
    {
      "id": "nodes/old@deleted",
      "kind": "delete",
      "nodeId": "nodes/old",
      "actor": "owner@x.com",
      "agent": "hootie",
      "at": "2026-09-27T22:00:00.000Z",
      "undo": { "available": false, "reason": "Deletions can't be undone here — deleting a document purges its history." }
    }
  ],
  "limit": 50,
  "offset": 0,
  "hasMore": false,
  "scope": "agents"
}
```

`kind` is `create` (the document's first version), `update`, `restore` (a revert or an earlier undo), or `delete`.

### POST `/nests/:nestId/agent-activity/undo`
Body: `{ "nodeId": "nodes/pricing", "version": 2 }`. Owners, admins and reviewers on that document (a read-tier reviewer is admitted, like `/approve`). Undo never rewrites history. It re-checks at call time and takes the normal write path:

- **published change** → restores the previous sealed version as a new version (same path as `POST …/revert`; change note `Undo of v2 by hootie — restored version 1`). In a governed nest the restore follows the usual review rules, so it may land as a draft awaiting approval.
- **draft** → discards it (`POST …/discard` semantics: back to the last published version, or the document is removed if it was never published).
- **the document's first version** (a create) → deletes the document.

Returns `{ ok, nodeId, undone, effect, version, status?, restoredVersion? }`. Errors:
- `409` with the reason when the document changed since (it names who changed it), the change is under review ("reject it from the review queue instead"), or the version isn't in the document's history
- `403` for editors/viewers
- `404` for a missing document
- `400` for a malformed body

### GET `/nests/:nestId/activity-log`
Query: `?node=<nodeId>` **or** `?folder=<path>` (neither = the whole nest), `&type=<t>[,<t>…]`, `&actor=<email>`, `&limit=50` (max 200), `&offset=0`.

The **admin activity log** for one document, one folder, or the nest: who changed, reviewed, commented on, deleted, read, retrieved or exported it, newest first. Owner, nest admin, or server admin only (the same rule as `/trace`); everyone else gets `403`. `400` for `node` and `folder` together, a traversal id or folder, or an unknown `type`.

It merges what the server records: versions (`created`, `edited`, `restored`, with the agent from the write's `client`), reviews (`review_requested`, `approved`, `rejected`, `review_cancelled`), comments (`commented`, `comment_resolved`), deletions (`deleted`), and document access, which leaves no version (`read`, `retrieved`, `exported`).

Access is recorded when a document is opened (`GET …/nodes/:id`, MCP `context_get`), returned by a search, query or context call (`/search`, `/query`, `/context` incl. Hootie, MCP `context_query` / `context_search` / `context_resolve`), or exported. A whole-nest export is one row with `nodeId: null` and appears in the nest's and folders' logs, and in the log of every document that existed at the time (not documents created afterwards). `detail` names how a document was accessed (`search`, `context`, `context_get`, `markdown export (12 documents)`); **what the caller searched for or asked is never stored**. Access rows are **sampled, not exhaustive**: throttled to one per person, document, action, surface and agent per 10 minutes, capped at 50 documents per retrieval, and pruned on the activity-trace retention window (`TRACE_RETENTION_DAYS`). The throttle is per server process, so a multi-instance deployment records up to one row per instance per window. Deleting a document purges its version and access history (the `deleted` tombstone stays).

```json
{
  "items": [
    {
      "id": "a:42",
      "type": "read",
      "nodeId": "nodes/sales/pricing",
      "title": "Pricing",
      "actor": "alice@acme.com",
      "agent": "claude-code",
      "client": { "agent": "claude-code" },
      "at": "2026-09-29T12:00:00.000Z",
      "surface": "mcp",
      "detail": "context_get"
    }
  ],
  "limit": 50,
  "offset": 0,
  "hasMore": false
}
```

The collaborator-facing `GET …/activity` and `GET …/nodes/:id/activity` feeds are unchanged and never include access rows.

### GET `/nests/:nestId/feed`
Query: `?filter=all|changes|comments&limit=50&offset=0&resolved=include` (filter defaults to `all`, limit caps at 200, offset caps at 10 000)

Nest **activity feed** — pending change submissions (the exact rows
`/review-queue` shows, every field intact, plus the caller's `canReview`)
interleaved with annotation activity (new comment threads AND replies),
newest first. Additive sibling of `/review-queue`; that endpoint and the MCP
`context_review_queue` tool are unchanged.

Comment items are access-filtered to documents the caller can read (same
resolution as node listing: public readers see approved docs only; grants and
steward scope honored). Change items mirror the queue (not access-filtered).

Comment items on **resolved** threads are left out (and out of
`counts.comments`): resolving a thread is how its comments leave the feed.
Pass `resolved=include` to get them back; the item shape is the same either
way (`resolved` is still reported).

```json
{
  "items": [
    {
      "type": "comment",
      "id": "<commentId>",
      "threadId": "<threadId>",
      "nodeId": "nodes/foo",
      "title": "Foo",
      "author": "reviewer@x.com",
      "snippet": "First ~200 chars of the comment…",
      "createdAt": "2026-07-14 11:00:00",
      "resolved": false,
      "isReply": true
    },
    {
      "type": "change",
      "id": "<reviewRequestId>",
      "nestId": "...",
      "nodeId": "nodes/foo",
      "title": "Foo",
      "version": 3,
      "requestedBy": "author@x.com",
      "requestedAt": "2026-07-14 10:00:00",
      "requestNote": "...",
      "status": "pending",
      "priority": "normal",
      "canReview": true,
      "createdAt": "2026-07-14 10:00:00"
    }
  ],
  "total": 2,
  "counts": { "changes": 1, "comments": 1 },
  "filter": "all",
  "limit": 50,
  "offset": 0
}
```

`counts` always carries both per-type totals regardless of `filter`; the UI
tab badge binds to `counts.changes` (actionable items), not the feed length.
The UI deep-links a comment item to its document with the thread focused via
`?nest=<id>&doc=<nodeId>&thread=<threadId>`.

### Notification rows (`GET /me/work` → `notifications`, `GET /me/notifications`)

Each row carries `nest_id`, `nest_name` (resolved in the same read, so the inbox navigates without fetching the nest list), `kind`, `message`, `created_at`, `read_at`, and `node_id` when the row is about a document (review verdicts, document deletion flags, mentions, `comment_reply` thread replies); nest-level rows have `node_id: null`.

Unread `nest_invite` rows are what the Nests page shows as **Pending invites**. Accept marks them read (`POST /me/notifications/read`) and opens the nest.

### POST `/me/nests/:nestId/leave`

Decline a nest invite. Removes the caller's **own** collaborator row on that nest (never anyone else's) and marks its `nest_invite` rows read. Response: `{ "left": true }`. Access that isn't a direct collaborator row — ownership, or a share through a team — isn't touched: `{ "left": false }`, and the invite rows are still marked read.

### GET `/me/drafts`

Query: `?limit=25&offset=0&q=&sort=updated|title` (limit clamps to 1–100, offset to ≥ 0)

`q` matches the title, the nest name and the node id, case-insensitively. `sort` defaults to `updated` (newest first). A title lives on disk rather than in SQL, so `q` and `sort=title` read the whole matching set (capped at 500 rows) and page it in memory — on those two, `total` counts what survives the filter and is exact.

Every document **you** left unsubmitted, across every nest you can see. A draft
that was never submitted has no `review_requests` row, so it appears in no
review queue and no `/me/work` bucket — this is the only surface that finds it
again. Backs the dashboard's "My Drafts" tab.

Included: nodes whose **latest** version row is authored by the caller with
status `draft` or `rejected`, and that have no pending review request (those
are already in `/me/work` under `waiting`). Approved/published documents are
deliberately excluded — they are not stranded work. Rows for deleted documents
are filtered out.

```json
{
  "drafts": [
    {
      "nest_id": "<nestId>",
      "nest_name": "GTM",
      "node_id": "nodes/gtm/cohere",
      "title": "Cohere Kill Sheet",
      "folder": "gtm",
      "status": "draft",
      "version": 3,
      "updated_at": "2026-07-23 09:12:00"
    }
  ],
  "pagination": { "total": 137, "limit": 25, "offset": 0, "has_more": true }
}
```

`total` is counted in SQL, before the existence filter that drops orphaned
version rows (a document deleted outside the app), so it can run one high and
leave a page one row short. `has_more` is derived from the **requested** page
size for that reason, not from the number of rows returned.

Submitting one is the ordinary `POST /nests/:nestId/nodes/:nodeId/submit-review`
— it then leaves this list and appears in `/me/work`.

---

## 7. Versions

### GET `/nests/:nestId/nodes/:nodeId/versions`

Version metadata plus each version's **change log** — the unified diff taking the
previous version to this one, as the engine stored it. `diff` is absent for v1
and for keyframe versions (a keyframe is a full snapshot, so there is no patch).

`content` is always `""` here. The list deliberately does **not** carry bodies:
attaching them means replaying the version chain once per row and shipping N
full copies of the document just to open the history panel. Fetch the one body
you need from `GET .../versions/:version` below.

Each version may also include `resolvedBy` + `resolutionStatus`, the steward who
approved or rejected it, joined from `review_requests` (`node_versions` stores
the status but not the resolver's email).

`client` is the caller attribution the write carried — which agent, in which
session (see [Caller attribution](#caller-attribution-client)). Absent on every
version whose write sent none, which includes every version written before the
field existed.

`externalEditVerdicts` carries the verdicts on out-of-band (direct filesystem)
edits, oldest first, read from the engine's append-only chain-event log. They sit
beside the version list rather than inside it because a **rejection commits no
content and therefore has no version** — minting one would renumber the chain.
An approval does commit, so it appears in both: as the version it created, and as
a verdict here. `note` is the rejection reason, or the approver's comment when
one was left.

Gated by the same node-level read check as the document itself — `403` when the
caller can't read the node, which for a public reader means any node without an
approved version.

```json
{
  "currentVersion": 3,
  "approvedVersion": 2,
  "versions": [
    {
      "version": 3,
      "editedBy": "author@x.com",
      "editedAt": "...",
      "status": "pending_review",
      "changeNote": "...",
      "content": "",
      "client": { "agent": "claude-code", "session_id": "s-9f2" },
      "diff": "Index: v2\n===...\n--- v2\tv2\n+++ v2\tv3\n@@ -1,4 +1,5 @@\n title: doc\n-old line\n+new line\n"
    },
    {
      "version": 2,
      "editedBy": "author@x.com",
      "editedAt": "...",
      "status": "approved",
      "changeNote": "...",
      "content": "",
      "resolvedBy": "reviewer@x.com",
      "resolutionStatus": "approved"
    }
  ],
  "externalEditVerdicts": [
    {
      "suggestion_id": "20240115T103000-a1b2c3d4",
      "status": "rejected",
      "actor": "reviewer@x.com",
      "at": "2024-01-15T10:34:00.000Z",
      "note": "not sourced",
      "source": "out-of-band-edit"
    }
  ]
}
```

### GET `/nests/:nestId/nodes/:nodeId/versions/:version`

One version's full body, reconstructed on demand from the nearest keyframe plus
the diffs after it.

`content` is `null` — with HTTP 200, not an error — when that version's chain can
no longer be replayed (e.g. history grafted by an older import). Callers render
it as "no content" rather than failing the whole panel.

Same node-level read check as the list above: `403` when the caller can't read
the node. A public reader can only reach versions of a node that has an approved
version, so drafts of an unapproved document are never reconstructable this way.

```json
{ "version": 2, "content": "# Heading\n\nbody as of v2\n" }
```

---

## 8. Comments & activity

Comments are a standalone collaboration primitive — **not** part of the
version/hash chain. They thread, carry attribution, anchor to a highlighted
span, and resolve (Word/Docs-style "Comments", separate from Track Changes).
Any caller with **read** access to the nest may leave or resolve a comment.

### GET `/nests/:nestId/nodes/:nodeId/comments?status=open`
List comments on a node. Optional `status` = `open` | `resolved`.
```json
{
  "comments": [
    {
      "id": "…",
      "nestId": "…",
      "nodeId": "nodes/spec",
      "version": 1,
      "anchor": { "start": 8, "end": 19, "text": "first draft" },
      "parentId": null,
      "author": "owner@x.com",
      "body": "This needs a citation.",
      "status": "open",
      "createdAt": "…"
    }
  ]
}
```

### POST `/nests/:nestId/nodes/:nodeId/comments`
Leave a comment. Body: `{ body, version?, anchor?{start,end,text?}, parentId? }`.
`parentId` threads a reply. Returns `201 { comment }`. Empty body → `400`.

**`@mentions` notify.** Every name in the comment body — `@user@host`,
`@localpart`, or `@(Display Name)` — is resolved against the nest's people
(`GET /nests/:nestId/mentionable`) and each person named gets a `mention` row
in `GET /me/notifications` linking the document, plus a message on the
configured connector and an email to their own address when SMTP is set up.
A channel message names who was mentioned (a room is not a person); the inbox
row and the email address the recipient directly. The author is never notified
about their own mention, a name matching nobody
(or matching two people ambiguously) notifies nobody, and a recipient who
can't open the document is skipped — so a mention can't disclose a title.
Unlike a document body, where only names a save *adds* notify, every name in a
comment notifies: the comment itself is the new event. At most 25 people are
notified per write (`MAX_MENTION_RECIPIENTS`) — commenting is read-tier and
unthrottled, so a comment naming a large roster would otherwise be an
amplifier; names are taken in order of appearance. With `PEOPLE_SUGGEST_ALL_USERS`
on, a name that matches a registered account off the nest is an invite: a
write+ author's mention adds them as a `read` collaborator and then notifies;
a read-only author's mention of an outsider still reaches nobody.

The *stream* of them is bounded too: per nest per 5 minutes, one person may
cause 50 mention **emails** (`MENTION_DELIVERY_BUDGET`) and 25 mention
**channel posts** (`MENTION_CHANNEL_BUDGET`) — separate pools, because emails
scale with how many people were named while a channel post is one message per
comment. Separate also so the email allowance doesn't depend on something
invisible: the connector dispatch is a no-op on a nest with no connector
configured, and a shared pool would have spent the token before it could say
so, quietly halving the email budget on exactly the deployments least likely to
have a connector. Past that the comment still posts and the
inbox rows still land — the queue is the recipient's own record and costs one
insert — and only the external fan-out is skipped, with a server-log warning.
The budget sits on delivery rather than on comment creation deliberately: an
agent working through a review posts a comment per finding, which is exactly
what `context_comment` is for, and throttling the write would break it. The same applies to the
annotation thread endpoints (§ Hosted artifacts), which are what the UI's
comments panel posts.

### POST `/nests/:nestId/nodes/:nodeId/comments/:commentId/resolve`
Mark a comment resolved. Records `resolvedBy` + `resolvedAt`. Returns `{ comment }`.

### GET `/nests/:nestId/nodes/:nodeId/activity` · GET `/nests/:nestId/activity`
Per-node (or nest-wide) activity log — "who did what". A read-only aggregation
over comments + committed edits (`node_versions`) + pending external-edit
suggestions ("proposed an edit", read from nest storage) + reviews
(`review_requests`); newest first, `?limit=` (default 100). Each entry:
`{ type, nodeId, actor, at, detail?, refId? }` where `type` ∈
`comment | comment_resolved | edit | edit_proposed | review_requested | review_resolved`.


### Annotations — anchored threads the editor's Comment mode shows

The comments above are flat per-node threads. **Annotations** are the highlight-anchored threads the editor's Comment mode and the artifact viewer show; MCP's `context_comments` / `context_comment` / `context_resolve_comment` operate on these. Read permission to view, write to post.

- `GET /nests/:nestId/nodes/:nodeId/annotations` — list threads with their replies and `open` / `resolved` status.
- `POST /nests/:nestId/nodes/:nodeId/annotations` — open a thread. Body: `{ body, anchor?: { start, end, text }, snapshotVersion? }`. No `anchor` = a whole-document (or whole-artifact) thread.
- `POST /nests/:nestId/nodes/:nodeId/annotations/:threadId/comments` — reply. Body: `{ body }`. A reply on a resolved thread reopens it (the MCP `context_comment` reply does the same). Everyone already in the thread (its opener and earlier repliers, minus the replier and anyone the reply @mentions) gets a `comment_reply` notification — an inbox row linking the document, plus an email when SMTP is configured.
- `POST /nests/:nestId/nodes/:nodeId/annotations/:threadId/resolve` · `/reopen`.
- `GET /nests/:nestId/comment-counts` — `{ "<nodeId>": <open thread count>, … }` for the whole nest in one call (the UI's "most commented" sort).

---

## 8b. Glossary definitions

A literal table-based ontology per nest: stewards/editors define and articulate
terms — existing `#tags` or brand-new vocabulary — and external runtimes (quant
analysis jobs, agents) pull them in real time. One row per `(nest, term)`,
case-insensitive. Reads are read-tier; writes are write-tier.

### GET `/nests/:nestId/definitions`
List the whole glossary, ordered by term.
```json
{
  "count": 1,
  "definitions": [{
    "id": "...",
    "nest_id": "...",
    "term": "CAC",
    "definition": "Customer acquisition cost: S&M spend / new customers, 90d.",
    "linked_tag": "#gtm",
    "defined_by": "owner@acme.com",
    "created_at": "...",
    "updated_at": "..."
  }]
}
```

### GET `/nests/:nestId/definitions?term=CAC`
Real-time single lookup — one indexed, case-insensitive query. `404` if the term
isn't defined.
```json
{ "definition": { "id": "...", "term": "CAC", "definition": "...", "linked_tag": "#gtm", "defined_by": "...", "created_at": "...", "updated_at": "..." } }
```

### POST `/nests/:nestId/definitions` (write+)
Upsert by term text (case-insensitive). New term → `201`; re-defining an existing
term updates it in place → `200`.
```json
{ "term": "CAC", "definition": "...", "linked_tag": "gtm", "editing_id": "<id?>" }
```
- `term` required, ≤ 200 chars. `definition` required. Non-string `term`/`definition`/`linked_tag` → `400`.
- `linked_tag`: omit = leave unchanged on update; `null`/`""` = clear; string = set (normalized to `#lowercase`).
- `editing_id` (optional): the id of the row being edited. Scopes the upsert to
  that row so a **rename replaces it in place** instead of overwriting whichever
  row happens to own the new term. If the new term already belongs to a
  **different** row → `409` (no data loss). Unknown `editing_id` → `404`. Omit it
  for the plain add form and real-time writers (pure upsert-by-term).

### DELETE `/nests/:nestId/definitions/:id` (write+)
```json
{ "deleted": true }
```
`404` if the id isn't in this nest.

---

## 8c. Edge-type registry ("turing" workflow plane)

The vocabulary of connections: the definitions-table move applied to relations.
Stewards articulate once what `next` or `escalates-when` MEANS in a nest; edges
then reference the registry. **Feature-flagged** — every route here `404`s
unless `FEATURE_WORKFLOW_PLANE` is on (env var or the admin-settings toggle).
Reads are read-tier; writes are write-tier. One row per `(nest, name)`,
case-insensitive.

On first touch a nest is lazily seeded with five stock types (attributed to the
nest owner): `next`, `on-success`, `on-failure` (flow types, form the DAG),
`depends-on`, `owned-by`.

### GET `/nests/:nestId/edge-types`
List the registry, ordered by name. Seeds the defaults if empty.
```json
{
  "count": 5,
  "edge_types": [{
    "id": "...",
    "nest_id": "...",
    "name": "next",
    "description": "Unconditional flow: after the source completes, run the target.",
    "direction": "directed",
    "is_flow": true,
    "condition_schema": null,
    "color": "#16a34a",
    "created_by": "owner@acme.com",
    "created_at": "...",
    "updated_at": "..."
  }]
}
```

### POST `/nests/:nestId/edge-types` (write+)
Upsert by name (case-insensitive). New name → `201`; re-defining an existing
name updates it in place → `200`.
```json
{
  "name": "escalates-when",
  "description": "Conditional escalation on a metric guardrail.",
  "direction": "directed",
  "is_flow": true,
  "color": "#f59e0b",
  "condition_schema": { "params": ["term", "op", "value"], "mode_default": "structured" }
}
```
- `name` required, ≤ 100 chars, `^[a-z0-9][a-z0-9-]*$` (alphanumeric-with-dashes). `description` required.
- `direction`: `directed` (default) | `undirected`. Anything else → `400`.
- `is_flow`: boolean, default `false`. Flow types form the workflow DAG.
- `color`: optional 6-digit hex (e.g. `#16a34a`). A malformed color → `400` (not silently dropped).
- `condition_schema`: optional `{ "params": [string…], "mode_default"?: "structured"|"nl"|"open" }`. Malformed → `400`. Stored normalized (`mode_default` defaults to `structured`).

### DELETE `/nests/:nestId/edge-types/:id` (write+)
```json
{ "deleted": true }
```
`404` if the id isn't in this nest. `400` if edges still reference the type
(delete those edges first — the DB enforces this with `ON DELETE RESTRICT`).

---

## 9. Query / Search (read-only consumers)

These power LLM context retrieval. Open-mode friendly.

### GET `/nests/:nestId/search?q=<term>`
Full-text search.
```json
{ "count": N, "nodes": [{ "id": "...", "title": "...", "tags": [...] }] }
```

### GET `/search?q=<term>&limit=20`
The same match, run across every nest the caller can see — for finding a
document without knowing which nest holds it. Each hit is stamped with its
nest, and per-nest stewardship filtering still applies, so results never
include a document the caller couldn't open directly.

`limit` caps the returned page (default 20, max 50) while `count` reports
everything found. `400` if `q` is missing.
```json
{
  "query": "onboarding",
  "count": 2,
  "nodes": [
    {
      "id": "nodes/onboarding-runbook",
      "title": "Onboarding Runbook",
      "type": "document",
      "tags": ["#hr"],
      "snippet": "how to onboard a...",
      "nest_id": "nest_abc",
      "nest_name": "Team Knowledge"
    }
  ]
}
```

### POST `/nests/:nestId/context`
One-call context retrieval for app/agent flows. Returns markdown ready to
prepend to an LLM prompt, plus a trace + node manifest. **Requires a license**
(it's a `POST`).

Body (give `prompt` OR `selector`; everything else optional):
```json
{
  "prompt": "how does auth work",
  "selector": "#auth",
  "max_tokens": 4000,
  "hops": 2,
  "include_drafts": false
}
```
- `prompt` — natural language. Tokens are matched against tag names and titles, and every document is scored against them (title hits weigh most, then tags, then body words); documents under half the top score are dropped as noise. A prompt that matches nothing returns `nodes: []` — never the whole nest. `trace.compiled.fallback` is `"fulltext"` when body scoring alone produced the answer.
- `selector` — explicit selector grammar (e.g. `#auth`). Wins over `prompt`. May carry `[[Title]]` parts in an OR union (`#auth | [[Auth Overview]]`), and `[[nodes/auth-overview]]` names one document by id where a title may match several.
- `hops` — link expansion depth (`[[wikilinks]]` and `contextnest://` links, both directions). Defaults to `0` for a `prompt` (neighbours of a keyword match are not answers to the question) and `2` for a `selector`.
- `max_tokens` — budget, floored at 50, default 4000. A node that doesn't fit is skipped and the next tried (`trace.truncated_by_budget` counts the skips); only when nothing fits does the first node go through oversized.
- 400 `prompt or selector is required` if both missing.
- Each node carries a `url` deep link, and its context block a matching `_source: <url>_` line, so answers can cite sources. Built from `PUBLIC_BASE_URL`, falling back to the request origin; omitted when neither resolves.
- On the `prompt` path each node also carries `score` (0–1; title hits weigh most, then tags, then body) and `via` (`"title"` | `"tag"` | `"fulltext"` | `"hop"`). `nodes` and the `context` blocks are ordered by score, so the budget keeps the best matches. Cite `via != "hop"`. Selector-path responses omit both fields.

Response (200):
```json
{
  "context": "# Auth Overview\n\n_tags: #auth #security_\n_source: http://localhost:3838/?nest=<nestId>&doc=nodes/auth-overview_\n\n# Auth\n\n...",
  "nodes": [{ "id": "nodes/auth-overview", "title": "Auth Overview", "url": "http://localhost:3838/?nest=<nestId>&doc=nodes/auth-overview", "tags": ["#auth"], "type": "document", "score": 0.67, "via": "tag" }],
  "trace": {
    "selector_used": "#auth",
    "from_prompt": "how does auth work",
    "compiled": { "matched_tags": ["auth"], "matched_titles": [], "unmatched_tokens": ["work"], "fallback": null },
    "included": 1,
    "permission_filtered": 0,
    "truncated_by_budget": 0,
    "approx_tokens": 24,
    "max_tokens": 4000
  }
}
```

```bash
curl -X POST 'http://localhost:3838/nests/<nestId>/context' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer cnst_...' \
  -d '{"prompt":"how does auth work","max_tokens":4000}'
```
Permission gating matches `/export` (public readers only see approved bodies).

### GET `/nests/:nestId/export?format=markdown` — LLM-pointed plain-text view
Stable URL an agent can fetch to get **`text/markdown`** (not JSON): every
accessible node serialized as YAML frontmatter + body, joined with `---`
separators. A `GET`, so it works on public nests without a license/credentials.

**Approved-only, for every caller.** Export never emits unapproved drafts —
not even for the owner. On a governed (stewardship-on) nest, each node's body
is its **approved version**, and nodes with no approved version yet are
omitted entirely. On an ungoverned nest there's no draft concept, so the
current body is exported.

Query params:
- `format=markdown` — **required** (else 400 `format=markdown is required`).
- `selector=<grammar>` — optional, narrows the set (e.g. `#auth`).
- `max_tokens=<n>` — optional budget; full set by default.

Response (`text/markdown; charset=utf-8`):
```markdown
---
title: "Auth Overview"
tags: ["#auth", "#security"]
status: "published"
id: "nodes/auth-overview"
---
# Auth

We use device auth + email/password fallback.

---

---
title: "Rate Limits"
tags: ["#api"]
status: "published"
id: "nodes/rate-limits"
---
# Limits

100 req/min per key.
```

```bash
# whole nest
curl 'http://localhost:3838/nests/<nestId>/export?format=markdown'

# narrow by selector
curl 'http://localhost:3838/nests/<nestId>/export?format=markdown&selector=%23auth'

# cap output size
curl 'http://localhost:3838/nests/<nestId>/export?format=markdown&max_tokens=2000'
```

Single node, same shape — add `?format=markdown` to the node read:
```bash
curl 'http://localhost:3838/nests/<nestId>/nodes/nodes/auth-overview?format=markdown'
```
Public readers receive the **approved** version body, never an unapproved
working-copy draft (same gate as `/context`).

### GET `/nests/:nestId/export?format=bundle` — portability bundle

Downloads a `.zip` of the nest's documents to move it to another ContextNest host. Each document is serialized from its approved/published state (`status: published`). Any collaborator with nest access (viewer and up) may export — same gate as the markdown export above. There is **no** separate import endpoint — unzip the bundle and bring it in with the existing folder importer (`POST /nests/import`).

- `?includeDrafts=1` — also export unapproved draft documents. Default: approved/published only.

Identities/attribution and the governance overlay (stewards, reviews, comments, definitions, edges, grants) do **not** travel; the importer owns and re-governs the fresh nest.

```bash
curl -OJ 'http://localhost:3838/nests/<nestId>/export?format=bundle'
curl -OJ 'http://localhost:3838/nests/<nestId>/export?format=bundle&includeDrafts=1'
```

### POST `/nests/:nestId/table-query`
Deterministic fact lookup against a **table** node (CSV body): fetch the exact rows instead of dragging the whole table into context. Same query against the same version always returns the same rows. Read permission; drafts excluded unless `include_drafts: true`.
```json
{ "table": "[[Price List]]", "query": "where region = \"EU\" and price > 100 select sku, price limit 5" }
```
`table` is a `[[Title]]` or a node id (`nodes/price-list`). Grammar: `where <col> <op> <value> [and …] [select <cols>] [limit N]`. Response:
```json
{ "table": "nodes/price-list", "version": 3, "columns": ["sku", "price"], "rows": [["A-1", "120"]], "matched": 7, "returned": 5, "total": 1000 }
```
Same operation over MCP: `context_table_query`.

### POST `/nests/:nestId/chat`
Hootie in the nest — ask a question about the nest and get a streamed, cited answer. Read tier, like `/context`: retrieval runs through the same `/context` path **as the caller**, so the answer can only draw on documents this person may read. Gated by `HOOTIE_ENABLED` (**off by default** — off → `404`); needs a model credential (missing → `503` with `reason: "no_api_key"`): the server's own `ANTHROPIC_API_KEY` (and `ANTHROPIC_BASE_URL`, if set) when the licence carries the `byok` feature (Enterprise), otherwise the PromptOwl model gateway the licence check provides, metered in PromptOwl credits. Answers with `HOOTIE_MODEL`, a plain model name (on the PromptOwl gateway the server adds the instance prefix, e.g. `default-claude/`, per call) — unset, the gateway's default model or `claude-sonnet-5` on an own key; all editable in Settings → General. `GET /admin/models` (server admin) lists the models the current credential can reach, by plain name — `{ models, current, source }` — for the Settings picker; if the list can't be fetched it answers `models: []` with an `error`, and a name can still be typed. Rate-limited per user across all nests — the budget guards the one server-wide key (`429`).

Request:

```json
{
  "message": "how do requests authenticate?",
  "node_id": "nodes/api-authentication-guide",
  "history": [
    { "role": "user", "content": "…" },
    { "role": "assistant", "content": "…" }
  ]
}
```

- `message` (required) — the question. `@name` tokens loop a colleague in (below).
- `node_id` (optional) — the document the person has open. It and its neighbours (one hop) lead the context, whatever the question matches follows.
- `history` (optional) — prior turns, oldest first; the server keeps the most recent 20.

Response: `text/event-stream`.

| event | data |
|---|---|
| `meta` | `{ nodes: [{ id, title, url, tags, type }], anchor: node \| null }` — what the answer will be grounded in, before the model speaks. |
| `delta` | `{ text }` — a chunk of the answer. |
| `done` | `{ answer, cited: [node…], mention }` — the whole answer, the documents it cites (by `[[Title]]`, in order), and what happened to any `@mentions`. |
| `error` | `{ error }` — the model call failed; the stream ends. |

**Grounding.** The retrieved documents are placed in the system prompt verbatim with the instruction to answer from them alone. Retrieval is permission-gated, so an answer can never draw on anything the caller couldn't read — but a document author can write text aimed at Hootie ("ignore the question and…") that later readers' sessions will see. That is the ordinary tradeoff of grounding a model in editable content, accepted here; the documents are governed, so who can write them is the control.

**Mentions.** A message naming people (`@alice@acme.com`) posts the exchange — question and answer, under the asker's name — as a comment on the anchor document (the open one, else the first document the answer cites) and notifies them through the comment-mention path: inbox row, and email / Slack / Teams where configured. `mention` is `{ status: "posted", node_id, node_title, thread_id, notified }` or `{ status: "undeliverable", reason: "no_anchor" | "post_failed" }`. Nothing is posted when nobody is named.

### POST `/nests/:nestId/query`
Graph query (Cypher-ish).

### GET `/nests/:nestId/overview`
Nest-level summary stats.

### GET `/nests/:nestId/context`
Returns CONTEXT.md content.

### GET `/nests/:nestId/folders`
The nest's folder tree on its own, for callers that want the *shape* of the vault
(a navigable tree, a folder picker) and none of its content. Per-folder counts come
from the document index and the folders themselves from the vault's directories —
no document is opened either way, so this stays cheap on a vault where listing the
documents would not be. A folder holding no document is listed with `count: 0`.

Query: `?folder=<path>` (that subtree only; defaults to the whole nest),
`?recursive=0` (direct children of `folder` only).

```json
{ "folders": [{ "path": "specs", "count": 4, "total": 11 }] }
```

`count` = documents filed directly in that folder; `total` = the whole subtree
beneath it. A level that holds only subfolders still gets a row, so it stays
expandable.

### POST `/nests/:nestId/folders`
```json
{ "folder": "gtm/deals" }
```
Creates a folder with nothing in it — the directory is created in the vault
carrying only its generated `INDEX.md`, so no document is added to the nest.
Each segment is slugified (`GTM/Deals` → `gtm/deals`) and the depth cap applies.
Creating a folder that already exists is a no-op. Write tier.

```json
{ "folder": "gtm/deals" }
```
Returns 201 with the path actually created.

### GET `/nests/:nestId/census`
One call for everything a nest overview needs to describe the *whole* nest,
whatever folder is open — counts by tag, type and status, the folder tree, the
author roster, and the recently-edited strip. Gated by the same `filterAccessible`
pass as the listing, so the numbers describe what this caller can actually reach.

```json
{
  "census": {
    "total": 42,
    "folders": [{ "path": "specs", "count": 4, "total": 11 }],
    "tags": { "#api": 7 },
    "types": { "document": 40, "agent": 2 },
    "statuses": { "approved": 30, "draft": 12 },
    "authors": ["a@x.com"],
    "editedLast7d": 5,
    "recent": [{ "id": "nodes/foo", "title": "Foo", "type": "document", "updated_at": "..." }]
  }
}
```

### POST `/nests/:nestId/reindex` (write+)
Force-rebuild the nest's document index from the vault, and return how many
documents were indexed: `{ "indexed": 42 }`.

The index heals itself — anything that could leave it out of step with disk (an
out-of-band edit, an import, a write that could not be mirrored) marks the nest
stale, and the next read rebuilds before answering. This is the manual lever for
when an operator wants that to happen *now*. A rebuild crawls the whole vault, so
it is write-tier rather than something a read-only caller can trigger at will;
below that the answer is `403`.

### GET `/nests/:nestId/graph` (read+)
Ontology graph — a read-only assembly over data the nest already holds, for the
graph view (links / stewardship overlay / coverage gaps). Gated to what the
caller can read (same `filterAccessible` pass as the other query routes).

Response `NestGraph`:
```json
{
  "nodes":   [{ "id": "nodes/alpha", "title": "Alpha", "type": "document", "tags": ["market-x"] }],
  "links":   [{ "source": "nodes/alpha", "target": "nodes/beta" }],
  "stewards":[{ "id": "jane@acme.com", "label": "jane@acme.com", "role": "reviewer", "scope": "tag", "target": "market-x" }],
  "stewardEdges":[{ "steward": "jane@acme.com", "target": "tag:market-x", "scope": "tag" }],
  "tags":    [{ "name": "market-x", "count": 2 }],
  "signals": {
    "orphans": [{ "id": "nodes/loose", "title": "Loose" }],
    "unstewardedTags": [{ "name": "market-y", "count": 1 }],
    "bottlenecks": [{ "steward": "jane@acme.com", "label": "jane@acme.com", "share": 67 }]
  },
  "truncated": false,
  "totalNodes": 3
}
```

Notes:
- **Identity masking** — steward `id`/`label` are the real email only for **write+**
  callers (same rule as the collaborators roster, so a public/read tier can't
  enumerate member emails). Sub-write callers get an opaque `"s1"` id and a
  `"Steward 1"` label; `bottlenecks[].label` follows suit.
- **Roster gating** — `stewards`/`stewardEdges` are empty for public/anonymous
  readers and when the nest has stewardship disabled.
- **Draw cap** — `nodes`/`links` are capped at 150 (highest-degree kept) with
  `truncated: true` and `totalNodes` set; `signals` are still computed over the
  full set so the gap numbers stay accurate.

### GET `/nests/:nestId/runnables` (read+)
Orchestrator surface: every **runnable** node (`type` `agent` or `skill`) with its
`schedule` and body in one call, so an external scheduler can connect, discover
what to run and when, and pull the prompt/skill content. Reuses the same
per-caller gating as the node list (`listNodesForCaller`), so stewardship and the
public-reader approved-only rule apply — a read-tier orchestrator key only ever
sees **approved** agent/skill definitions; unapproved drafts are omitted.

```json
{
  "count": 1,
  "runnables": [{
    "id": "nodes/nightly-digest-agent",
    "title": "Nightly Digest Agent",
    "type": "agent",
    "schedule": "0 6 * * *",
    "status": "published",
    "tags": ["#ops"],
    "updated_at": "...",
    "content": "# Agent\n\n..."
  }]
}
```
- `schedule` is `null` when the node carries no schedule.
- Filtering to runnable types happens before the per-node governance/version
  enrichment, so cost scales with the number of runnables, not total nest size.

### POST `/nests/:nestId/publish`
Bulk-create documents (and/or update `CONTEXT.md`) in one call. Each document
routes through the same create path as `POST /nests/:nestId/nodes` — same slug
derivation, same governance rows, same content-type policy gate (a disabled
`artifact`/`table` type fails the whole batch up front, before any write).

Body: `{ documents?, context_md? }` — at least one required.
`documents[]` rows are `{ title, content, type?, tags?, scope? }`; rows missing
`title` or `content` are skipped silently (a shape problem, not a policy one).

A document whose title slugs to an id that already exists is **skipped and
reported** — never overwritten, so republishing a folder cannot destroy an
existing document's version history.

A document the create path rejects for its own reasons — a title that is too
long or carries no sluggable characters, a `type` the engine does not know — is
**reported in `failed` and the batch continues**. One bad row cannot abandon the
rest half-written.

```json
{
  "published": 2,
  "context_md_updated": true,
  "node_ids": ["nodes/alpha", "nodes/beta"],
  "skipped": ["Existing Doc Title"],
  "failed": [{ "title": "Bad Row", "error": "..." }]
}
```

Returns `201` whenever the batch ran, even if every row landed in `skipped` or
`failed` — read the arrays, not the status, to know what happened.

`context_md` is written directly rather than through an operation, because none
exists for it. It is therefore outside the vault write lock and has no `503` to
return — a `context_md`-only request cannot report contention.

**Partial writes and retries.** The batch is not a transaction: documents are
created one at a time and the ones written before a failure stay written. The
one error that stops the batch early is the vault write lock being held past
its acquire timeout, which answers `503` + `Retry-After`. Retrying is safe and
finishes the job — every document from the first attempt now exists, so it
comes back under `skipped` while the remaining ones are created. Expect a
lower `published` count on the retry; that is the batch converging, not a
failure.

---

## 8c. Publish links — public hosting of a single document

Expose ONE document as a standalone page at a stable, unguessable
`/p/<slug>` URL. Distinct from nest visibility (whole-nest read) and from
grants (authenticated per-user sharing). Managing publish links is owner/admin
only. Access modes: `public` (no auth), `code` (shared passcode), `email`
(viewer enters an email → one-time magic link → access logged), `invite`
(same, but only allow-listed emails get a link). Every served view is logged;
links are revocable and can carry `expires_at`.

### POST `/nests/:nestId/publications` (owner/admin)
Body: `{ node_id, access_mode?: "public"|"email"|"code"|"invite",
comments_enabled?: bool, watermark?: bool, no_download?: bool,
code?: string (code mode), allowlist?: string[] (invite mode),
expires_at?: ISO }`. → `201 { publish, link }`.

`watermark` stamps the viewer's email across the page — email/invite gates only,
since the other two identify nobody. `no_download` blocks copy, right-click,
drag and printing; both are deterrents, not protection (screenshots and
developer tools still work). `400` when `node_id` names no document in the nest,
or when `email`/`invite` is requested on a server with no mail transport
(`SMTP_URL` + `NOTIFY_EMAIL_FROM`) — their one-time link could never be sent.

### GET `/nests/:nestId/publications` (owner/admin)
List this nest's publish links with their `link` URLs.

### GET `/nests/:nestId/publications/:id/views` (owner/admin)
The access log — `{ count, views: [{ email, created_at }] }`.

### DELETE `/nests/:nestId/publications/:id` (owner/admin)
Revoke — the link 404s immediately.

### Public render surface (no auth chain)
- `GET /p/:slug` — the document, a gate form (email/code/invite), or — when
  `comments_enabled` — a reader shell framing the document beside the comment
  control. Document bodies are served under the strict artifact sandbox
  (opaque origin); markdown nodes are rendered server-side.
- `GET /p/:slug/view` — the document itself, always sandboxed. The shell frames
  it; gated independently, so being the frame source is not authorization.
- `POST /p/:slug/gate` — submit a code (unlock) or an email (send magic link).
  Rate limited per link per IP.
- `GET /p/:slug/verify?token=` — consume a magic link → set session cookie → open.
  Invite mode re-checks the allow-list here, not only when the link was sent.
- `POST /p/:slug/comments` — JSON `{ body, email? }`, from the shell's modal.
  Needs the gate cleared and an identifying email; lands as an unanchored
  annotation thread for stewards, never on the published page.

Only the approved version is ever served — a document with no approved snapshot
404s rather than exposing a draft. A revoked, expired or unknown slug answers
every route above with the same HTML notice, never a hint about which it was.

---

## 9b. Workflow plane ("turing")

**Feature-flagged — every route below `404`s unless `FEATURE_WORKFLOW_PLANE=true`** (Settings → Workflow plane). Typed edges, an edge-type registry, and governed runs. Full contract in [`WORKFLOW_PLANE.md`](./WORKFLOW_PLANE.md). Reads are read-tier, mutations write-tier via the standard nest gate.

### Edge types — the vocabulary of relations

- `GET /nests/:nestId/edge-types` (read) — list the registry. Seeds the five stock flow types (`next`, `on-success`, `on-failure`, `depends-on`, `owned-by`) on first touch.
- `POST /nests/:nestId/edge-types` (write) — upsert by name (case-insensitive). Body: `{ name, description, direction?, is_flow?, condition_schema?, color? }`. `name` is a slug (`^[a-z0-9][a-z0-9-]*$`); `is_flow` types are DAG-validated; `condition_schema` is `{ params: string[], mode_default? }`. `201` on create, `200` on update.
- `DELETE /nests/:nestId/edge-types/:id` (write) — refused (`400`) while any edge references it.

### Edges — typed, condition-carrying links

- `GET /nests/:nestId/edges?type=<name|id>&node=<id>` (read) — list, optionally filtered by edge type and/or an endpoint node.
- `POST /nests/:nestId/edges` (write) — Body: `{ from_node, to_node, type, condition_mode?, condition?, metadata? }`. Both endpoints must be real nodes in the nest; `type` must exist in the registry. `condition_mode` ∈ `structured | nl | open` (`structured` predicates whose `term` must resolve against the glossary). Creating a flow edge that would close a cycle → `409` naming the path.
- `DELETE /nests/:nestId/edges/:id` (write).

### Runs — the operational trace (server never executes)

- `POST /nests/:nestId/run/:agentNode` (write) — trigger a run. Body: `{ inputs?, parent_run_id? }`. Returns `201` with the executable **bundle**: `{ run_id, parent_run_id, depth, agent{content,…}, edges[<reachable flow subgraph>], definitions[], trace_hint }`. `triggered_by` is derived from auth, never client-supplied. Only `agent`/`skill` nodes are runnable (else `400`). `parent_run_id` spawns a **sub-agent run** nested under a still-running parent (`FEATURE_SUBAGENT_RUNS`, off by default — any `parent_run_id` is `400` while off); it's bounded by `SUBAGENT_MAX_DEPTH` (depth → `403`) and `SUBAGENT_MAX_CHILDREN` (fan-out → `403`, enforced atomically with the insert), rejects re-entrancy of an agent already in the ancestor chain (`409`), and refuses a closed (`409`) or unknown/cross-nest (`404`) parent.
- `POST /runs/:id/steps` (write) — append one step. Body: `{ action: read|write|branch|notify|external, node_id?, edge_id?, detail? }`. `seq` is server-assigned (monotonic, atomic); any client `seq` is ignored. `409` if the run is already terminal, or once the run hits `RUN_MAX_STEPS`.
- `PATCH /runs/:id` (write) — close/update. Body: `{ status: running|succeeded|failed|cancelled, trace? }`. Compare-and-swap on `status='running'`: a second close → `409` ("terminal is final").
- `GET /runs/:id` (read) — full trace `{ run, steps[] }`. Freeform payloads (`run.inputs`, `run.trace`, `steps[].detail`) are redacted to `null` below write tier.
- `GET /nests/:nestId/runs?agent=&status=&limit=` (read) — run history, newest first (same read-tier redaction).

> The `/runs/:id*` family mounts outside the per-nest gate, so it re-checks nest-scope keys, suspension and license itself before any write — the same guarantees the `/nests/:nestId/*` gate provides.

### Schedules — run an agent on a timer

- `GET /nests/:nestId/schedules` (read) — list.
- `POST /nests/:nestId/schedules` (write) — Body: `{ agent_node, every_minutes, enabled?, max_runs? }`. `max_runs` stops the schedule after that many runs.
- `PATCH /nests/:nestId/schedules/:id` (write) — `{ every_minutes?, enabled? }`.
- `DELETE /nests/:nestId/schedules/:id` (write).

Archived nests are skipped by the scheduler tick; restoring the nest resumes them.

### Metacognition agents — the server runs these (`FEATURE_METACOGNITION`)

Every route `404`s unless both `FEATURE_WORKFLOW_PLANE` and `FEATURE_METACOGNITION` are on. See [`WORKFLOW_PLANE.md`](./WORKFLOW_PLANE.md#the-one-exception-metacognition-agents).

- `GET /nests/:nestId/metacognition` (write) — `{ agents: [{ node_id, enabled, persona{name,avatar,email}, scope{read[],propose[]}, caps{max_steps,max_tokens,max_seconds,max_proposals}, feeds[], mcp_servers[], model, configured_by, updated_at }] }`.
- `GET /nests/:nestId/metacognition/:node` (write) — one agent.
- `PUT /nests/:nestId/metacognition/:node` (owner/admin, else `403`) — make an **agent** document a metacognition agent, or update it. Body: `{ persona: { name, avatar? }, scope?: { read?: string[], propose?: string[] }, caps?: {…}, feeds?: [{ name, url }], mcp_servers?: [{ name, url, allowed_tools: string[], auth_env? }], model?, enabled? }`. Folders are under `nodes/`. `read`: empty = the whole nest. `propose`: empty = **no proposals** (fail closed), `["*"]` = anywhere it may read, otherwise folders inside `read`. Caps are clamped to server ceilings (turns ≤ 50, tokens ≤ 2M, seconds ≤ 1800, proposals ≤ 20). Feed and MCP URLs must be public `https` (`400` otherwise); an MCP server must list `allowed_tools`. `auth_env` names a nest env value sent as a bearer token; it must start `MCP_`, so a config can't send the model key or another secret out. The first save creates the persona — a service identity (`persona-…@agents.invalid`) that can't sign in and isn't listed as a person. The saver becomes `configured_by`: their access bounds the agent's.
- `DELETE /nests/:nestId/metacognition/:node` (owner/admin) — stop treating the document as a metacognition agent. The document and the persona's history stay.
- `POST /nests/:nestId/metacognition/:node/run` (write) — start a run now → `202 { run_id, executes: "server" }`; `409` while one is running. `POST /nests/:nestId/run/:node` does the same for a metacognition agent (no bundle is handed out), as do its schedules and inbound hooks.

The run is an ordinary run (`GET /runs/:id`): `claimed_by: "server:metacognition"`, steps `read` (search/list/read), `write` (`detail.kind: "proposal"`, `"access_needed"`, `"withdrew_rejected_draft"`), `notify` (comment), `external` (feed/MCP), `branch` (`detail.kind: "reasoning"`). Its `trace` is `{ persona, model, billing: "promptowl_credits"|"own_key", usage{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}, est_cost_usd, proposals, stopped_by: end_turn|max_steps|max_tokens|max_seconds|refusal|turn_max_tokens, summary }`, or `{ persona, skipped }` (status `cancelled`) when it couldn't start. `POST /runs/:id/steps` on a metacognition run → `409`; `PATCH /runs/:id` accepts only `cancelled`.

### Inbound hooks — let the outside world trigger a run

- `GET /nests/:nestId/hooks?agent=` (read) — list, tokens masked.
- `POST /nests/:nestId/hooks` (write) — Body: `{ agent_node, preset }` with `preset` = `slack` | `teams` | `webhook`. Returns the secret URL once.
- `DELETE /nests/:nestId/hooks/:id` (write) — accepts the full token or the masked id.
- `POST /hooks/:token` (public — the token is the auth) — fire it. The Slack and Teams presets verify the request signature against `SLACK_SIGNING_SECRET` / `TEAMS_WEBHOOK_SECRET` in the nest's env store; the message text becomes the run's `inputs`. `404` while the nest is archived.

### Env — per-nest secrets for tools and the runner

- `GET /nests/:nestId/env` (write+) — names and masked tails only; values are never read back.
- `PUT /nests/:nestId/env` (write+) — `{ key, value }` creates or replaces.
- `DELETE /nests/:nestId/env/:key` (write+).

Values ride to the runner inside the run bundle. `ANTHROPIC_API_KEY` here overrides the server-wide default from Settings.

### Connectors — governance events out to a channel

Not behind the workflow-plane flag: connectors fire on review events too.

- `GET /nests/:nestId/connectors` (read).
- `POST /nests/:nestId/connectors` (write) — Body: `{ channel, url, events }`. `channel` = `slack` | `teams` | `webhook`; `url` is a literal `https://…` or `env:KEY` to pull it from the env store; `events` is a non-empty array of `review_requested`, `review_approved`, `review_rejected`, `run_failed`, `mention`, or `["*"]`.
- `PATCH /nests/:nestId/connectors/:id` (write) — `{ enabled?, events?, url? }`.
- `DELETE /nests/:nestId/connectors/:id` (write).

---

## 9. MCP

### `/nests/:nestId/mcp/*`
Model Context Protocol endpoints — JSON-RPC over HTTP. Not exercised manually; LLM clients connect here.

**Transport is read-tier.** MCP Streamable HTTP is always POST (even `initialize` / `tools/list`), so the per-nest gate admits any credential with read access; every mutating tool re-checks its own permission inside the tool handler (create/edit via stewardship, approve/reject via reviewer rights, stewards/sharing/sync via their own admin checks).

**Denials are JSON-RPC.** Gate rejections on the MCP transport path return a JSON-RPC error envelope — `{ "jsonrpc": "2.0", "id": <echoed>, "error": { "code": -32000, "message": "<what failed — actionable reason>" } }` — instead of plain `{error}` JSON, so external clients (PromptOwl, Claude Desktop, Cursor) surface *why* a connection failed: key scoped to a different nest, server suspended, license required, or nest not found / no access.

**Every tool takes `client`.** The `{ agent, session_id, …custom }` block described in [Caller attribution](#caller-attribution-client) is advertised on every tool's input schema, reads included — a write that seals a version records it there (`context_versions` serves it back), and every call records it on the activity trace. It is never authenticated and never used to authorize. Omitted, the server fills what the connection reports (the API key's label, an `Mcp-Session-Id` header) under anything the caller sent, per key.

**Titles are unique on this surface.** `context_get`, `context_update`, `context_versions`, `context_delete`, and `context_move` each resolve a document by title or by id (an id wins when both are sent, and an ambiguous title refuses rather than guessing). Title addressing is what makes uniqueness matter, so `context_create` refuses a title already used anywhere in the nest — including in another folder — and answers with the existing node's id plus what to do instead (`context_update` to change it, `context_move` to refile it). A duplicate would otherwise be unreachable by every tool here. REST `POST /nodes` keeps the looser rule (same title in a different folder is fine); both surfaces refuse a create whose id is already taken.

**`context_search` is the REST search.** The tool runs the same index-backed match as `GET /nests/:id/search` — terms against the cached discovery set (title, body, type, tags), title hits first — and gates the *hits* with the same `filterAccessible` rule (public readers: approved-only; governed nests: steward coverage or a share grant), so the two surfaces return the same documents in the same order. It takes an optional `limit` (default 20, max 200) and answers `{ results, count }`: `count` is everything found, `results` the first `limit` hits, each with its LLM-visible body (approved version under stewardship; a hit with no approved version yet is listed but carries no body). It used to resolve every document's gated body *before* matching — one permission lookup plus one version reconstruction per node — which is what timed out `ctx search --vault <remote>` on large governed nests.

**Deletion requests** mirror the REST + UI flow, so an agent isn't left at a dead end when `context_delete` refuses:
- `context_request_deletion` — flag a document (by title/id), a `folder`, or the whole `nest` with a required `reason`. Read-tier: anyone who can see a thing may ask for its deletion. Nothing is removed; a refused `context_delete` now names this tool.
- `context_deletion_queue` — pending (or `declined`) requests with their reasons and request ids.
- `context_resolve_deletion` — `delete` or `decline` (note required) by request id. **Owner/admin only** — the transport is read-tier, so this per-tool check is the only thing between a viewer and a deleted nest.

**Comments read AND write.** `context_comments` reads a document's threads (anchored quotes, replies, open/resolved) — the same annotation store the web UI's comments panel shows. Two write tools close the loop so an agent handed feedback can answer it rather than only read it:

- `context_comment` — leave a comment. Omit `thread` to open a new whole-document thread; pass a `thread` id from `context_comments` to reply into it. One tool for both, because they differ only by that argument.
- `context_resolve_comment` — resolve a thread, or `reopen: true` to put it back. The caller is recorded as the resolver, exactly as in the UI.

Both are **read-tier**, matching REST (`isAnnotationAction` in `app.ts`): a reviewer who can see the document may comment on it. The transport is read-tier too, so each tool re-checks `canReadNode` itself — that check is the real gate. Deliberately *not* gated on an approved version: a reviewer comments on drafts, and writing a comment discloses nothing (the caller supplies the text), whereas *reading* threads stays gated because anchors quote draft body text. Both run the same side effects the REST routes do — the `@mention` fan-out (so tagging a human notifies them) and the derived `— Annotations` re-projection for artifacts, so an agent's comment doesn't leave that node stale. A `thread` that belongs to another document is refused by name rather than silently opening a new thread.

`context_comments` is also available on the **server-level** endpoint (nest-parameterised, read-only). Comment visibility matches UI node visibility: collaborators/stewards who can read the node may read its threads even before approval; public readers remain blocked until the document is approved. Comment *writes* stay per-nest with the other write tools.

**`context_my_drafts`** mirrors `GET /me/drafts`, nest-scoped: the caller's own unsubmitted (or rejected) documents in this nest, with their path and version. Capped at the 100 most recent; the reply says so explicitly when there are more, so an agent can't read a capped page as the whole set. Self-scoped by construction — it only ever returns rows the caller authored, in a nest they already hold read on, so it needs no permission check of its own. It exists because an agent otherwise cannot see its own unsubmitted work: a draft has no review request, so `context_review_queue` never lists it, and `context_query` skips it (only approved versions are AI-readable). The response names `context_submit_review` as the next step.

Server-admin-only tools (gated by `isLicenseAdminUserId` in non-open mode, same as their REST counterparts):
- `context_unsynced_list` — mirrors `GET /nests/unsynced`.
- `context_sync_folder` — mirrors `POST /nests/unsynced/sync`. Args: `name` (folder path relative to `DATA_ROOT`).

Both reuse the same `listUnsyncedFolders` / `syncUnsyncedFolder` service functions the REST routes call, so a single fix lands in both surfaces.

### Workflow-plane tools (only advertised when `FEATURE_WORKFLOW_PLANE=true`)

Let an MCP agent **build and execute** governed workflows without leaving the tool surface. Each shares the exact service/validator code its REST counterpart uses (run-service, edge-routes, edge-type-routes), so the two surfaces can't drift. Write tools require write tier on the nest; run-detail tools additionally scope the `run_id` to the MCP nest.

Build:
- `workflow_edge_types_list` / `workflow_edge_type_upsert` / `workflow_edge_type_delete` — mirror the `/edge-types` routes.
- `workflow_edges_list` / `workflow_edge_create` / `workflow_edge_delete` — mirror the `/edges` routes (DAG cycle guard + condition validation included).

Execute (the runner contract — the agent IS the runner):
- `workflow_run` — trigger; returns the executable bundle (agent body + reachable subgraph + definitions + `run_id`).
- `workflow_run_step` — append a step (server-assigned `seq`).
- `workflow_run_close` — close with a terminal status (`409`-equivalent conflict on a second close).
- `workflow_run_get` / `workflow_runs_list` — read traces/history (freeform payloads redacted below write tier).

### PromptOwl native connection (service-ticket auth)

The official PromptOwl deployment connects on its users' behalf without storing
a `cnst_` key: it mints a short-lived HS256 **service ticket** signed with the
shared secret configured for it as an official community site (`/admin/community-sites`,
or the legacy `OFFICIAL_COMMUNITY_SSO_SECRET` env var — see `CONFIGURATION.md`). The ticket
carries `scope: "mcp"`, an `aud` bound to this server's `PUBLIC_BASE_URL`, a
~5-minute `exp`, and **no `jti`**. It resolves to an already-existing account by
email — native access never auto-provisions.

Accepted as a `Bearer` on exactly these paths (everything else still requires a
real credential):
- `GET /index` and the server-level `ALL /mcp` — cross-nest index + read tools (including `context_comments`).
- `POST /nests/:id/context` and `GET /nests/:id/nodes` — retrieval + doc listing.
- `ALL /nests/:id/mcp` — the per-nest MCP transport, so a block granted read &
  write on one nest reaches that nest's write tools. Per-nest permission,
  suspend, and license gates all apply exactly as for a `cnst_` key.

Two **server-level bootstrap writes** on `ALL /mcp` let a single-connection
client create content (everything else on server-level `/mcp` is read-only):
- `nest_create` — new nest owned by the caller (refused for a nest-scoped key).
- `context_create` — new document in a nest the caller can write to
  (`canCreateInNest`). Both honor the suspend kill-switch and license gate.

**Ticket kinds don't cross over.** An `mcp`-scoped ticket is refused at
`GET /auth/sso` (it can't become a login session), and the MCP middleware
refuses any ticket carrying a `jti` (the mark of a one-time SSO login ticket) —
enforced on both sides, not by trusting the issuer.

---

## 10. Admin / operator

### GET `/health` (no auth)
`{ "status": "ok" | "suspended", "version": "<server version>", … }`. Needs no key (like `/llms.txt` and public `/p/:slug` pages) — use it for liveness probes. `suspended` means the license was revoked and writes are refused until a valid key is installed.

Hootie fields: `hootie_enabled` (default `false`), `hootie_brand` — `{ name, logo_url, accent_color, greeting }`, the identity every surface should show (the admin's custom one on an Enterprise licence, otherwise `{ name: "Hootie", logo_url: null, accent_color: null, greeting: null }`, decided server-side) — and `hootie_branding_available` (whether custom identity is allowed).

### Hootie identity — `/admin/settings` fields (Enterprise)
`hootie_name` (one line, ≤40 chars), `hootie_logo_url` (`https://` image: `.png`/`.jpg`/`.gif`/`.webp`), `hootie_accent_color` (hex, normalised to `#rrggbb`), `hootie_greeting` (one line, ≤200 chars). `""` resets a field to the default. GET returns the stored values plus `hootie_branding_available`. "Enterprise licence" here means the licence carries the `hootie_branding` feature (PromptOwl's licence check returns the licence's `features`; an Enterprise licence has it by default, and PromptOwl can grant or revoke it per licence). A PATCH that would **change** any of these without it is refused as a whole — `403 { code: "enterprise_required" }` (the code name is kept for wire compatibility; it means the licence lacks `hootie_branding`), nothing written, including the request's other fields. Sending back the stored values unchanged is allowed (they are ignored). Invalid values → `400` with `fieldErrors` keyed by field. `hootie_enabled` is written explicitly (`true`/`false`), so a UI choice beats the deploy env.

### Superadmins — GET/POST `/admin/super-admins`, DELETE `/admin/super-admins/:email` (server-admin only)
Grant and revoke **superadmins** (server-wide admins) from the API/UI instead of only via `access.yaml`. The effective superadmin set is the union of three sources, surfaced per row as `source`:

- `license` — the PromptOwl account that owns the installed license. Derived live; never revocable here.
- `config` — `access.yaml` `super_admins`. The authoritative bootstrap: **never revocable via the API** (lockout safety) — edit the file and restart instead.
- `granted` — rows in the `super_admins` DB table, managed by these endpoints.

All three routes use the same server-admin guard as `GET /admin/trace` (license admin, or any effective superadmin; open mode: always allowed). Emails are case-insensitive and stored lowercased. A superadmin holds `admin` on every nest, sees `/admin/trace` + `/admin/settings`, and can manage teammates (`/auth/teammates`, invite, reset-password, remove).

**GET `/admin/super-admins`** → `200`:
```json
{
  "super_admins": [
    { "email": "owner@acme.com", "source": "license", "granted_by": null, "granted_at": null, "self": true },
    { "email": "ops@acme.com",   "source": "config",  "granted_by": null, "granted_at": null, "self": false },
    { "email": "jane@acme.com",  "source": "granted", "granted_by": "owner@acme.com", "granted_at": "2026-07-17 14:03:22", "self": false }
  ]
}
```
An email present in several sources shows its least-revocable origin (`license` > `config` > `granted`). `self` marks the caller's own row.

**POST `/admin/super-admins`** with `{ "email": "jane@acme.com" }` → `201 { email, source: "granted", granted_by }`.
- `400` — missing/malformed email, or no user account with that email exists on this server (invite them as a teammate first).
- `409` — already an effective superadmin (any source).

**DELETE `/admin/super-admins/:email`** → `200 { ok: true, email }`. Guards:
- `400` — target is the license admin, or an `access.yaml` entry (file is authoritative; remove from the file + restart).
- `400` — **last-admin lockout guard**: you can't revoke *yourself* when you're the last effective superadmin (no license admin, no `access.yaml` entries, no other grants) — grant someone else first.
- `404` — email has no granted row.

Grants persist in the database and are loaded into the in-memory resolution cache at startup and after every grant/revoke, so they survive restarts. Surfaced in the UI on **Teammates → Superadmins** with per-source badges, add-by-email, and confirm-to-revoke.

### Community sites — GET/POST `/admin/community-sites`, PATCH/DELETE `/admin/community-sites/:id` (server-admin only)
Manage the **official community sites** trusted for one-click SSO auto-login (`GET /auth/sso` — see above). Each row is a `{ name, url, secret, is_active }` connection; `url` is a display/uniqueness field, not used for audience binding. `GET /auth/sso` tries an incoming ticket's signature against every *active* site's secret, and validates the ticket's `aud` claim against this deployment's own `PUBLIC_BASE_URL` (the same value for every candidate). Replaces the single `OFFICIAL_COMMUNITY_SSO_SECRET`/`PUBLIC_BASE_URL` env-var pair with a DB-backed list for the *secret* side — the env-var pair still works as an implicit extra "legacy" entry, so existing single-site deployments are unaffected. Surfaced in the UI at **Settings → Community sites**.

Same server-admin guard as `/admin/super-admins` (license admin, any effective superadmin; open mode: always allowed).

**GET `/admin/community-sites`** → `200 { community_sites: [{ id, name, url, secret_set, is_active, created_at, updated_at }] }`. `secret` is **write-only** — never returned, only whether one is set.

**POST `/admin/community-sites`** with `{ name, url, secret, is_active? }` → `201` with the row shape above (`is_active` defaults to `true`).
- `400` — missing name, invalid/non-http(s) url, or a secret under 16 characters.
- `409` — a site with this url already exists.

**PATCH `/admin/community-sites/:id`** — any subset of `{ name, url, secret, is_active }`; omit `secret` to keep the current one. Same validation and `409` as POST. `404` if the id doesn't exist.

**DELETE `/admin/community-sites/:id`** → `200 { ok: true, id }`. `404` if the id doesn't exist.

Active sites are loaded into an in-memory cache at startup and refreshed after every write, so `GET /auth/sso` never blocks on a DB round trip per request.

### GET `/admin/trace` (server-admin only)
Operator activity trail — one newest-first row per API request and per MCP tool call, so the server admin has a single place to audit what every client and agent did. Server-admin only: the license admin, or a `super_admin` in `access.yaml` (open mode: always allowed). Everyone else gets `403`. Cross-tenant data; not scoped to a nest.

Rows are best-effort fire-and-forget writes to the `api_events` table (a broken trace table never fails a real request) on a rolling retention window of **`TRACE_RETENTION_DAYS`** days (default **14**; `0` = keep forever — see `CONFIGURATION.md`; also editable from Settings → Basic). API rows come from a global request-logging middleware; MCP rows are logged inside `handleToolCall`, so both per-nest and server-level tool calls — including ones that throw — are captured.

Query params (all optional):
- `kind` — `api` or `mcp`. Omit for both.
- `user` — substring match on caller email, or exact user id.
- `nest` — filter to a single nest id.
- `limit` — page size, clamped to `1..1000` (default `25`). Non-numeric values fall back to the default rather than erroring.
- `offset` — rows to skip for pagination (default `0`). The UI pages in blocks of 25 (`offset = page * 25`).

`total` is the full filtered row count (independent of `limit`/`offset`), so the client can render a pager. `count` is the number of rows on the current page.

Response (200):
```json
{
  "count": 2,
  "total": 137,
  "limit": 25,
  "offset": 0,
  "events": [
    {
      "id": 412,
      "ts": "2026-07-03T13:58:44.812Z",
      "kind": "mcp",
      "method": null,
      "path": null,
      "tool": "context_overview",
      "nest_id": "nest_abc",
      "user_id": "usr_123",
      "caller": "alice@acme.com",
      "status": 200,
      "duration_ms": 14
    },
    {
      "id": 411,
      "ts": "2026-07-03T13:58:44.790Z",
      "kind": "api",
      "method": "POST",
      "path": "/nests/nest_abc/nodes",
      "tool": null,
      "nest_id": "nest_abc",
      "user_id": "usr_123",
      "caller": "alice@acme.com",
      "status": 201,
      "duration_ms": 23
    }
  ]
}
```
- `kind` — `api` (HTTP request) or `mcp` (tool call).
- `method` / `path` — set on `api` rows; `null` on `mcp` rows.
- `tool` — set on `mcp` rows; `null` on `api` rows.
- `caller` — resolved caller email (from the row's stored email or a join on `user_id`).
- `status` — HTTP status for `api` rows; `200` (success) / `500` (threw) for `mcp` rows.
- `duration_ms` — wall-clock duration of the call.

Surfaced in the UI under the user menu → **Activity trace** (`ActivityTracePage`), with kind/user filters, 25-per-page pagination, and a refresh button.

### GET `/nests/:id/trace` (nest owner / nest admin)
The per-nest steward slice of the activity trace. Same response shape, pagination, and `kind` / `user` / `limit` / `offset` query params as `GET /admin/trace`, but every row is **always pinned to this nest server-side** — there is no `nest` param, and one supplied in the query is ignored, so a caller can never read another nest's activity through this endpoint.

Authorization mirrors the grants / steward-roster rule (`canManageStewards`): the nest owner, an `admin` collaborator, the license admin, or an `access.yaml` `super_admin` (open mode: always allowed). Read/write collaborators get `403`; callers with no access to the nest get `404`.

Surfaced in the UI from the nest view's overflow menu → **Activity trace** (owner/nest-admin only), which renders `ActivityTracePage` in nest-scoped mode (nest column hidden).

---

## Permission middleware quick-ref

For any `/nests/:nestId/...` request, the middleware computes:
- `permission` = effective nest perm: `owner | admin | write | read | none`.
- Required level by path:
  - `/collaborators`, `/visibility` → `admin`
  - `/reader-mode` → `admin` at the middleware, then the handler hard-gates on `isServerAdminUserId` (superadmin only)
  - `/branding` → `admin` at the middleware (owner, admin collaborator, or server admin), re-checked in the handler; `hide_powered_by: true` additionally requires the server admin
  - Stewardship action paths (`/approve`, `/reject`, `/submit-review`, `/cancel-review`) → `read` (handler enforces fine-grained steward gating)
  - Other non-GET → `write`
  - GET → `read`

Returns 403 `Insufficient permissions` if not met. Open-mode (`AUTH_MODE=open`) treats everyone as `owner`.

License gate: any non-GET request OR any governance path requires a valid PromptOwl license (`/license/install`). Otherwise 503. **Who hears why:** a server admin (open mode, license owner, superadmin), or the key's owner after it lapsed, gets `{ "error": "License required", "reason": "...", "setup_url": "/setup", "trial", "expires_at", "days_left", "license_reason", "grace_ends_at", "contact": { "url", "email" } }` (or `"Server suspended by PromptOwl"` with `reason`, `contact`, `contact_url`). Everyone else gets only `{ "error": "This workspace is read-only right now. Your administrator has been notified.", "read_only": true }`, with no licensing vocabulary. The server-level `/mcp` write tools and run writes follow the same rule.

---

## License

The server validates its key with PromptOwl (`POST {PROMPTOWL_API_URL}/api/license/validate`) at startup and every 60s. Each check sends the key plus `stats: { users, nests }` (the head-count the license is billed on) and `server: { version, public_url }`. It is part of validation, so it is sent even with `TELEMETRY_ENABLED=false`, and it never includes content.

- **Seats are reported, never enforced.** Over the licensed seats, new people still join. The admin sees a private notice, and PromptOwl follows up.
- **Expiry has a 14-day grace period on PromptOwl's side.** While `reason` is `expired_grace` the server works normally until `grace_ends_at`.
- **A lapse makes the server read-only, with no lock-out.** When PromptOwl rejects the key 3 checks in a row (about 3 min) or a suspension is confirmed (two suspended answers within an hour — the next 60s check, so about a minute), writes return 503 as above. Reads keep working. Sessions and the installed key are kept, so a renewal or reactivation restores the server on the next check with nothing to reinstall.

### GET `/license/status` (public)
`{ valid, tier, org, owner_email, suspended, suspended_reason, limits, setup_required }`. `setup_required` is true only for a server that has never been licensed; the UI shows the activation screen then. A lapsed license is not a setup case. Carries no lapse reason, dates, head-count or contact.

### GET `/admin/license` (server admin, or the key's owner)
`{ plan, valid, tier, org, owner_email, suspended, suspended_reason, trial, expires_at, days_left, reason, grace_ends_at, contact: { url, email }, seats: { licensed, used, over_limit, at_limit }, subscribers: { licensed, used }, max_account_owners, pending_rejections, last_checked_at, manage_url }`. `plan` is `free`, `trial`, `self_hosted` or `enterprise`. `seats` counts billed users (nest owners, admins, reviewers, server admins) and `subscribers` counts editors; each person counts once, at their highest role. A `licensed` or `max_account_owners` of null means no limit. `manage_url` is PromptOwl's page for this key (`?key=` carries its last 4 characters only), or null without a key. `pending_rejections` counts rejections not yet acted on (3 make the server read-only). Drives Settings → License and the admin license banner.

### POST `/license/install`
`{ key }`. Public while the server has never been licensed. Once it has a license owner, only a server admin or that owner may replace the key (401/403 otherwise). A rejected key returns 400 with an operator-facing `error` plus the same term fields.

---

## Error shapes

| Status | When |
|---|---|
| 400 | Validation error (`{ "error": "..." }`) |
| 401 | Auth required |
| 403 | Permission denied (`Insufficient permissions`, governance steward mismatch) |
| 404 | Nest / node / steward not found, or caller has no permission |
| 402 | Plan limit: a role grant would pass the plan's cap. `{ "error", "code": "plan_limit", "limit": "users" \| "subscribers" \| "account_owners", "max" }`. Only raises are checked; demotions and viewers always go through. `error` tells a server admin to upgrade and anyone else to ask their admin |
| 409 | Conflict (e.g., key already exists, version conflict) |
| 429 | Rate limit |
| 503 | License missing |

---

## Quick test sequence (Postman)

1. `POST /auth/login` → grab session cookie OR `POST /auth/keys` → copy `api_key`.
2. `POST /nests` → grab `nestId`.
3. `PATCH /nests/:nestId/settings` → `{ "stewardship_enabled": true }`.
4. `POST /nests/:nestId/nodes` → grab `node.id`.
5. `POST /nests/:nestId/stewards` → `{ scope:"document", email:"rev@x.com", role:"reviewer", nodePattern:"<node.id>" }`.
6. As `rev@x.com` → `POST /auth/register` (claims placeholder) → cookie stored.
7. `GET /nests` as reviewer → nest visible (proves auto-collab worked).
8. `GET /nests/:nestId/nodes` as reviewer → only the assigned doc visible (proves stewardship filter).
9. As original user → `POST /nests/:nestId/nodes/:nodeId/submit-review`.
10. As reviewer → `POST /nests/:nestId/nodes/:nodeId/approve` → 200.
11. `GET /nests/:nestId/nodes/:nodeId/versions` → confirm `resolvedBy` populated on the approved version.
