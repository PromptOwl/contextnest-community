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
{ "label": "cli" }
```
Response (201):
```json
{ "api_key": "cnst_...", "id": "uuid", "label": "cli" }
```
**Plaintext shown once.**

### POST `/auth/keys/rotate` (auth required)
Replaces existing key, returns new plaintext.

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
{ "stewardship_enabled": false }
```

### PATCH `/nests/:nestId/settings` (admin/owner)
```json
{ "stewardship_enabled": true }
```

### PATCH `/nests/:nestId/visibility` (admin)
```json
{ "visibility": "public" }
```

### GET `/nests/unsynced` (server-admin only outside open mode)
Lists folders under `DATA_ROOT` that aren't nests yet — typically dropped in by the starter CLI or copied in manually. Each entry is a sync candidate. Reflects server-side filesystem state, so in non-open mode only the license admin sees it (everyone else gets `403`).

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

## 4. Nodes (documents)

`nodeId` = relative path without `.md`, e.g. `nodes/api-design`.

### GET `/nests/:nestId/nodes`
Lists all readable docs.
- When `stewardship_enabled = true`, list is filtered by `filterAccessible` — non-steward users only see what they're assigned to.
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
    "author": "...",
    "created_at": "...",
    "updated_at": "...",
    "content": "# md body",
    "schedule": "0 6 * * *"
  }]
}
```
- `schedule` is present only on runnable nodes (`type` `agent`/`skill`); omitted otherwise.

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
- Optional `folder` (string) nests the doc → `nodes/<folder>/<slug>`. Each `/`-separated segment is slugified independently (so `../` or absolute paths can't escape the vault); empty segments drop. Max 8 levels deep; each segment (and the title slug) max 100 chars — otherwise `400`.
- Optional `schedule` (free-form cron/interval string, opaque to the server) — **only valid when `type` is `agent` or `skill`**; sent on any other type → `400`. Stored in frontmatter metadata and echoed back on every node response. See [§9 `GET /runnables`](#get-nestsnestidrunnables-read).
- If stewardship enabled → status defaults `draft`. Else `approved`.
- Auto-syncs tag index for steward resolution.

Response (201): `{ "node": { ... }, "stewards": [...] }`.

### GET `/nests/:nestId/nodes/:nodeId`
Full node content. 403 if no steward access (when stewardship on).
Add `?format=markdown` to receive `text/markdown` (frontmatter + body) instead
of JSON — see [§8 export](#get-nestsnestidexportformatmarkdown--llm-pointed-plain-text-view).

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

### DELETE `/nests/:nestId/nodes/:nodeId`
Write permission. Hidden in UI for reviewer/viewer; server still enforces.

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

---

## 7. Versions

### GET `/nests/:nestId/nodes/:nodeId/versions`
**Enriched** (recent change) — each version may include `resolvedBy` + `resolutionStatus` pulled from `review_requests`.
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
      "changeNote": "..."
    },
    {
      "version": 2,
      "editedBy": "author@x.com",
      "editedAt": "...",
      "status": "approved",
      "changeNote": "...",
      "resolvedBy": "reviewer@x.com",
      "resolutionStatus": "approved"
    }
  ]
}
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

---

## 10. Admin / operator

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
