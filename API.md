# ContextNest Community — API Reference

Base URL: `http://localhost:3838`
Default port: `3838` (override via `PORT` env)

## Authentication

Two methods, evaluated in order:

1. **Cookie session** — `cnst_session=<id>` (set by `/auth/login` and `/auth/register`). Browser default.
2. **Bearer API key** — `Authorization: Bearer cnst_<token>` (issued by `/auth/keys`). Use for Postman / external tools.

Anonymous open mode (`AUTH_MODE=open`) bypasses auth on most read endpoints.

All bodies are JSON unless noted. All errors return `{ "error": "msg" }` with appropriate HTTP status.

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
Mints an API key for the caller. 409 if one already exists — use rotate.
```json
{ "label": "cli", "nest_id": "optional — scope the key to one nest" }
```
Response (201):
```json
{ "api_key": "cnst_...", "id": "uuid", "label": "cli" }
```
**Plaintext shown once.** Omit `nest_id` for a **user-level key** (works on every nest the user can access — what the Connect dialog mints); a nest-scoped key is rejected on other nests' MCP/API paths.

### POST `/auth/keys/rotate` (auth required)
Replaces existing key, returns new plaintext. Scope resolution on the optional `nest_id` field: **absent** → keep the prior scope; **`null` (or `""`)** → clear to a user-level key; **a nest id** → scope to that nest. Same for `label` (absent keeps the prior label).

### GET `/auth/keys` (auth required)
Lists key prefixes (no plaintext).

### DELETE `/auth/keys/:keyId` (auth required)
Revoke a key.

### POST `/auth/password` (auth required)
```json
{ "current_password": "...", "new_password": "..." }
```

### POST `/auth/invite` (admin only)
Creates an invited user and returns a **temporary password** (once) for the admin to hand off. No API key is minted — teammates sign in with the temp password, then mint their own key from the Connect modal.
```json
{ "email": "teammate@x.com" }
```
- New email → user row with `is_invited = 1` and a temporary password.
- Existing, not-yet-claimed email (`is_invited = 1`, hasn't logged in) → refreshes the temp password.
- Existing, claimed email (has logged in or set their own password, `is_invited = 0`) → `409`; use Reset password instead.

`is_invited` clears to `0` on the teammate's first successful login (or when they set their own password).

Response (201):
```json
{
  "temporary_password": "...",
  "user": { "id": "...", "email": "..." },
  "message": "Share this temporary password securely — it won't be shown again."
}
```

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
One-click SSO auto-login from PromptOwl (**official deployment only**). PromptOwl redirects a signed-in user here with a short-lived, single-use, audience-bound HS256 JWT ticket (`?ticket=...`). The server verifies the signature with `OFFICIAL_COMMUNITY_SSO_SECRET`, checks `aud` against `PUBLIC_BASE_URL`, enforces one-time-use via the ticket's `jti`, then provisions the user and starts a session (same provisioning + `PROMPTOWL_SIGN_IN_GATE` as `/auth/promptowl`). On success → `302` to `/`; on failure → `302` to `/?sso_error=<code>` (the SPA shows a toast). **When `OFFICIAL_COMMUNITY_SSO_SECRET` is unset** (i.e. every self-hosted server) the feature is disabled and the endpoint bounces to `/?sso_error=not_supported`. That is the domain lock: without the shared secret no ticket can be verified, so the feature stays exclusive to the official community regardless of this redirect. Error codes: `not_supported`, `missing_ticket`, `invalid_ticket`, `bad_audience`, `ticket_used`, `rate_limited`, `sign_in_restricted`, `service_error` (DB/internal fault while redeeming the ticket).

### GET `/auth/oidc/login`
Starts generic **OIDC single sign-on** (Microsoft Entra ID, Google, or any spec-compliant IdP). Superadmin-configurable via `/admin/settings` (`oidc_*` fields) or the `OIDC_*` env vars — see `CONFIGURATION.md → Single sign-on (OIDC)`. Entirely separate from the PromptOwl flows above.

When enabled and fully configured: fetches the issuer's discovery document (cached in-process ~5 min), mints `state` + `nonce` + a PKCE S256 verifier into three short-lived (10 min) httpOnly `SameSite=Lax` cookies scoped to `Path=/auth/oidc`, and `302`s to the IdP's authorization endpoint with `response_type=code&scope=openid email profile`. When disabled/unconfigured → `302` to `/?sso_error=disabled` / `not_configured`. Rate-limited per IP.

### GET `/auth/oidc/callback`
The redirect URI (`<base url>/auth/oidc/callback` — register this exact URI at your IdP). Verifies the `state` param against the flow cookie, exchanges the code at the token endpoint (client secret + PKCE verifier), validates the ID token with the issuer's JWKS (signature, `iss`, `aud` = client id, `exp`, and the `nonce` claim against the flow cookie), extracts the email (`email`, falling back to `preferred_username` for Entra; normalized trim+lowercase), and enforces `oidc_allowed_domains`. Existing users are signed in; unknown users are JIT-provisioned when `oidc_auto_provision` is on (name from the `name` claim), else refused. Every successful login also upserts `users.department` from the optional string `department` claim (trimmed, whitespace collapsed, capped at 120 chars; absent claim clears the stored value) — read by the `oidc_department_tagging` feature (see `CONFIGURATION.md → Department auto-tagging`). On success → session cookie (identical to a password login) + `302` to `/`. On any failure → `302` to `/?sso_error=<code>`; codes: `disabled`, `not_configured`, `discovery_failed`, `provider_error`, `state_mismatch`, `exchange_failed`, `invalid_token`, `email_not_verified` (ID token carries `email_verified: false` — an absent claim is trusted; see the trust assumption in `CONFIGURATION.md → Single sign-on (OIDC)`), `domain_not_allowed`, `not_invited`, `rate_limited`, `service_error`. Flow cookies are cleared on every outcome. Rate-limited per IP.

### GET `/auth/oidc/logout`
RP-initiated logout for an SSO session. Deletes the current session server-side and clears the session cookie plus the `cnst_sso_session` marker. If the issuer advertises an `end_session_endpoint` (Entra/Okta/Keycloak; Google does not), `302`s the browser through it with `post_logout_redirect_uri=<base url>/` so the IdP session ends too; otherwise `302`s straight to `/`. Always clears cookies and always lands on `/`, even if discovery is unreachable. The SPA navigates here (instead of `POST /auth/logout`) only when the non-httpOnly `cnst_sso_session` marker cookie — set on OIDC callback success — is present, so password sessions keep the plain logout.

Related `/admin/settings` fields (GET/PATCH, superadmin only): `oidc_enabled`, `oidc_issuer` (https URL), `oidc_client_id`, `oidc_client_secret` (**write-only** — PATCH sets/replaces, `null` clears; GET returns only `oidc_client_secret_set: boolean`), `oidc_allowed_domains` (comma-separated), `oidc_auto_provision`, `oidc_department_tagging` (append `dept:<slugified-department>` to a new document's tags on create — create-only, no-op for users without a stored department). Enabling is refused unless issuer + client id + secret are all present.

---

## 2. Nests

A nest = a context vault (folder of markdown documents + governance state).

### GET `/nests`
Returns owned + shared nests.
```json
{ "nests": [{ "id": "...", "user_id": "...", "name": "...", "slug": "...", "visibility": "private", "created_at": "..." }] }
```

### POST `/nests`
```json
{ "name": "My Nest", "description": "optional" }
```
Response (201): `{ "nest": { ... } }`

### GET `/nests/:nestId`
```json
{ "nest": { ... }, "permission": "owner" | "admin" | "write" | "read" }
```
404 if caller has no permission.

### DELETE `/nests/:nestId`
Owner only.

### GET `/nests/:nestId/settings`
```json
{
  "stewardship_enabled": false,
  "allow_self_approve": false,
  "prime_only_review": false,
  "prime_tags": ["prime-document"]
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

Turning stewardship **off** wipes stewards and pending reviews and is owner-only; the other fields are non-destructive and never change the state of anything already published.

### PATCH `/nests/:nestId/visibility` (admin)
```json
{ "visibility": "public" }
```

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

---

## 3a. Teams (group sharing)

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
    "content": "# md body",
    "schedule": "0 6 * * *"
  }]
}
```
- `schedule` is present only on runnable nodes (`type` `agent`/`skill`); omitted otherwise.
- `author` = the doc's creator (frontmatter author, else the first version's author); `null` for old imports with neither. `collaborators` = distinct version authors ∪ document-scope grant holders, minus the author, sorted. Both also appear on the single-node GET below.
- Public readers (callers who reach a `visibility: public` nest without being its owner or a collaborator) do **not** receive `collaborators` — the field is omitted, and `author` falls back to the frontmatter value only, never to a version author. The roster is treated as private to the nest's members, like draft content.

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
  "schedule": "0 6 * * *"
}
```
- Slug derived from title → `nodes/<slug>`.
- Optional `folder` (string) nests the doc → `nodes/<folder>/<slug>`. Each `/`-separated segment is slugified independently (so `../` or absolute paths can't escape the vault); empty segments drop. A leading `nodes/` segment is stripped, so `nodes/gtm/deals` and `gtm/deals` mean the same folder. Max 8 levels deep; each segment (and the title slug) max 100 chars — otherwise `400`.
- `409` when the derived id is already taken (same folder + same title). The existing document is left untouched — update it, or pick another folder or title. The same title in a *different* folder is still allowed here; MCP `context_create` is stricter and refuses it (see [§9 MCP](#9-mcp)).
- Optional `schedule` (free-form cron/interval string, opaque to the server) — **only valid when `type` is `agent` or `skill`**; sent on any other type → `400`. Stored in frontmatter metadata and echoed back on every node response. See [§9 `GET /runnables`](#get-nestsnestidrunnables-read).
- Optional `prime` (boolean) flags the document as **prime** — it then always requires steward approval, whoever writes it. Owner/admin only; any other caller sending the field gets `403`. Omit to inherit from the nest's `prime_tags`; `false` exempts this document from an otherwise-prime tag. Echoed back on every node response as `prime` (absent when inherited). See `STEWARDSHIP.md → Prime documents`.
- If stewardship enabled → status defaults `draft`. Else `approved`.
- Auto-syncs tag index for steward resolution.

Response (201): `{ "node": { ... }, "stewards": [...] }`.

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
Response: `{ "ok": true, "version": <new>, "node": { ... } }`. `400` without a valid `targetVersion`; `404` if that version doesn't exist.

### PATCH `/nests/:nestId/nodes/:nodeId`
Headers (optional): `X-Base-Version: 3` — server returns 409 on conflict.
```json
{
  "title": "...",
  "content": "...",
  "tags": ["..."],
  "changeNote": "fixed typo",
  "schedule": "0 7 * * *"
}
```
Requires nest write permission.
- `schedule` — runnable types (`agent`/`skill`) only; sent for any other type → `400`. Send `""` to clear it.
- `prime` — owner/admin only (`403` otherwise). `true`/`false` set the document-scope flag, `null` clears it back to tag/nest inheritance. An edit that makes the document prime is itself gated, so it lands as a draft awaiting approval.

### DELETE `/nests/:nestId/nodes/:nodeId`
Write permission. Hidden in UI for reviewer/viewer; server still enforces.

A node with a pending review is frozen — `423` — for callers who can't clear that review. Approvers (nest owner, admin, assigned reviewer) go through: they can reject and then delete, so the lock only cost them a round trip. Same rule on `POST /nodes/:nodeId/move`; editing under review is unchanged (still author-only).

Purges everything keyed to the node id — version history, review requests, the approved-version pin, tag index, annotations and their comments, review comments, watchers, schedules, trigger hooks, workflow edges, document-scoped stewards and document grants — and leaves a deletion tombstone for `GET /changes`. Node ids derive from titles, so a later document can land on the same id; it must inherit none of the old one's readers, reviewers or history. Run traces are kept: they record what happened, not what exists. `POST /nests/:nestId/nodes/:nodeId/move` carries that same set to the new id instead of dropping it (folder grants excepted — they cover a path prefix, so a moved doc leaves one share and joins another).

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

### GET `/nests/:nestId/nodes/:nodeId/reviews`
Full review history for a node.

### POST `/nests/:nestId/nodes/:nodeId/request-deletion`
Body: `{ "reason": "superseded by the new runbook" }` (required).

Read permission — anyone who can see the node may flag it as stale, which is the point: deleting is write-tier, so the people who notice dead content usually can't act on it. A flagged node is **not** locked or under review; it stays editable and never appears in the review queue. One pending flag per node (`409` on a second), `404` for a node the caller can't read or that doesn't exist. Returns `201 { request }`.

`GET /nests/:nestId/nodes/:nodeId` carries `deletionRequest` — the node's latest flag (`{ status, requestedBy, reason, resolvedBy?, resolutionNote?, resolvedAt? }`) or `null`. `pending` lets a client badge the document and drop its request affordance rather than discovering the `409`; `declined` carries the resolver's note, which is how the person who asked learns the verdict.

### POST `/nests/:nestId/request-deletion`
Body: `{ "targetType": "folder" | "nest", "target": "api/limits", "reason": "..." }` (`target` ignored for `nest`).

Read permission, same as the per-document route. A folder target is normalized (`/nodes/api/limits/` → `api/limits`) so two people flagging the same folder collide on one pending request rather than raising two; `404` if no documents live under it. One pending flag per (nest, target type, target).

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
Honours the request — write permission, the same tier `DELETE /nodes/:nodeId` requires (including its `423` review lock). Branches on the request's `targetType`: a document goes through `deleteNode`, a folder through the bulk delete above, a nest through `deleteNest`.

A **nest** target additionally requires owner/admin: deleting a whole nest is the owner's call (`DELETE /nests/:id` enforces that), and honouring a request must not be a way around it — a write-tier collaborator gets `403`.

An honoured request always leaves the queue: a document's row is purged with its other node-keyed rows, a nest's cascades with the nest, and a folder's — which is neither — is dropped explicitly.

Raising a request notifies the nest owner + owner/admin collaborators: a `/me/work` inbox row, the `deletion_requested` connector event (Slack/Teams/webhook), and a direct email. Resolving it — either way — notifies the requester the same way (`deletion_deleted` / `deletion_declined`). All delivery is best-effort; a notification failure never fails the action.

`GET /me/work` returns these alongside reviews as items with `type: "deletion"`, carrying `reason` and `request_id`. They land in `items` only for nest owners/admins (the tier that can delete) and in `waiting` for whoever raised them.

### POST `/nests/:nestId/deletion-requests/:id/decline`
Body: `{ "note": "still referenced by onboarding" }` (required). Write permission. Keeps the node and the row, recording who declined and why. `404` once the request is no longer pending.

### GET `/nests/:nestId/feed`
Query: `?filter=all|changes|comments&limit=50&offset=0` (filter defaults to `all`, limit caps at 200, offset caps at 10 000)

Nest **activity feed** — pending change submissions (the exact rows
`/review-queue` shows, every field intact, plus the caller's `canReview`)
interleaved with annotation activity (new comment threads AND replies),
newest first. Additive sibling of `/review-queue`; that endpoint and the MCP
`context_review_queue` tool are unchanged.

Comment items are access-filtered to documents the caller can read (same
resolution as node listing: public readers see approved docs only; grants and
steward scope honored). Change items mirror the queue (not access-filtered).

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

### GET `/me/drafts`

Query: `?limit=25&offset=0` (limit clamps to 1–100, offset to ≥ 0)

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

### POST `/nests/:nestId/nodes/:nodeId/comments/:commentId/resolve`
Mark a comment resolved. Records `resolvedBy` + `resolvedAt`. Returns `{ comment }`.

### GET `/nests/:nestId/nodes/:nodeId/activity` · GET `/nests/:nestId/activity`
Per-node (or nest-wide) activity log — "who did what". A read-only aggregation
over comments + committed edits (`node_versions`) + pending external-edit
suggestions ("proposed an edit", read from nest storage) + reviews
(`review_requests`); newest first, `?limit=` (default 100). Each entry:
`{ type, nodeId, actor, at, detail?, refId? }` where `type` ∈
`comment | comment_resolved | edit | edit_proposed | review_requested | review_resolved`.

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
- `prompt` — natural language, compiled to a selector server-side.
- `selector` — explicit selector grammar (e.g. `#auth`). Wins over `prompt`.
- `max_tokens` — budget, floored at 50, default 4000. Nodes past the budget are dropped (`trace.truncated_by_budget`).
- 400 `prompt or selector is required` if both missing.

Response (200):
```json
{
  "context": "# Auth Overview\n\n_tags: #auth #security_\n\n# Auth\n\n...",
  "nodes": [{ "id": "nodes/auth-overview", "title": "Auth Overview", "tags": ["#auth"], "type": "document" }],
  "trace": {
    "selector_used": "#auth",
    "from_prompt": "how does auth work",
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

### GET `/nests/:nestId/export?format=bundle` — portability bundle (owner/admin)

Downloads a `.zip` of the nest's documents to move it to another ContextNest host. Each document is serialized from its approved/published state (`status: published`). Owner or admin only. There is **no** separate import endpoint — unzip the bundle and bring it in with the existing folder importer (`POST /nests/import`).

- `?includeDrafts=1` — also export unapproved draft documents. Default: approved/published only.

Identities/attribution and the governance overlay (stewards, reviews, comments, definitions, edges, grants) do **not** travel; the importer owns and re-governs the fresh nest.

```bash
curl -OJ 'http://localhost:3838/nests/<nestId>/export?format=bundle'
curl -OJ 'http://localhost:3838/nests/<nestId>/export?format=bundle&includeDrafts=1'
```

### POST `/nests/:nestId/query`
Graph query (Cypher-ish).

### GET `/nests/:nestId/overview`
Nest-level summary stats.

### GET `/nests/:nestId/context`
Returns CONTEXT.md content.

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
Publishes the nest (snapshots + index).

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

---

## 9. MCP

### `/nests/:nestId/mcp/*`
Model Context Protocol endpoints — JSON-RPC over HTTP. Not exercised manually; LLM clients connect here.

**Transport is read-tier.** MCP Streamable HTTP is always POST (even `initialize` / `tools/list`), so the per-nest gate admits any credential with read access; every mutating tool re-checks its own permission inside the tool handler (create/edit via stewardship, approve/reject via reviewer rights, stewards/sharing/sync via their own admin checks).

**Denials are JSON-RPC.** Gate rejections on the MCP transport path return a JSON-RPC error envelope — `{ "jsonrpc": "2.0", "id": <echoed>, "error": { "code": -32000, "message": "<what failed — actionable reason>" } }` — instead of plain `{error}` JSON, so external clients (PromptOwl, Claude Desktop, Cursor) surface *why* a connection failed: key scoped to a different nest, server suspended, license required, or nest not found / no access.

**Titles are unique on this surface.** `context_get`, `context_update`, `context_delete`, and `context_move` all resolve a document by title, so `context_create` refuses a title already used anywhere in the nest — including in another folder — and answers with the existing node's id plus what to do instead (`context_update` to change it, `context_move` to refile it). A duplicate would otherwise be unreachable by every tool here. REST `POST /nodes` keeps the looser rule (same title in a different folder is fine); both surfaces refuse a create whose id is already taken.

**Deletion requests** mirror the REST + UI flow, so an agent isn't left at a dead end when `context_delete` refuses:
- `context_request_deletion` — flag a document (by title/id), a `folder`, or the whole `nest` with a required `reason`. Read-tier: anyone who can see a thing may ask for its deletion. Nothing is removed; a refused `context_delete` now names this tool.
- `context_deletion_queue` — pending (or `declined`) requests with their reasons and request ids.
- `context_resolve_deletion` — `delete` or `decline` (note required) by request id. **Owner/admin only** — the transport is read-tier, so this per-tool check is the only thing between a viewer and a deleted nest.

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
shared `OFFICIAL_COMMUNITY_SSO_SECRET` (see `CONFIGURATION.md`). The ticket
carries `scope: "mcp"`, an `aud` bound to this server's `PUBLIC_BASE_URL`, a
~5-minute `exp`, and **no `jti`**. It resolves to an already-existing account by
email — native access never auto-provisions.

Accepted as a `Bearer` on exactly these paths (everything else still requires a
real credential):
- `GET /index` and the server-level `ALL /mcp` — cross-nest index + read tools.
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

### GET `/admin/trace` (server-admin only)
Operator activity trail — one newest-first row per API request and per MCP tool call, so the server admin has a single place to audit what every client and agent did. Server-admin only: the license admin, or a `super_admin` in `access.yaml` (open mode: always allowed). Everyone else gets `403`. Cross-tenant data; not scoped to a nest.

Rows are best-effort fire-and-forget writes to the `api_events` table (a broken trace table never fails a real request) on a rolling retention window of **`TRACE_RETENTION_DAYS`** days (default **14**; `0` = keep forever — see `CONFIGURATION.md`; also editable from Settings → Advanced). API rows come from a global request-logging middleware; MCP rows are logged inside `handleToolCall`, so both per-nest and server-level tool calls — including ones that throw — are captured.

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
  - Stewardship action paths (`/approve`, `/reject`, `/submit-review`, `/cancel-review`) → `read` (handler enforces fine-grained steward gating)
  - Other non-GET → `write`
  - GET → `read`

Returns 403 `Insufficient permissions` if not met. Open-mode (`AUTH_MODE=open`) treats everyone as `owner`.

License gate: any non-GET request OR any governance path requires a valid PromptOwl license (`/license/install`). 503 `License required` otherwise.

---

## Error shapes

| Status | When |
|---|---|
| 400 | Validation error (`{ "error": "..." }`) |
| 401 | Auth required |
| 403 | Permission denied (`Insufficient permissions`, governance steward mismatch) |
| 404 | Nest / node / steward not found, or caller has no permission |
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
