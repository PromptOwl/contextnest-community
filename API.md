# ContextNest Community — API Reference

Base URL: `http://localhost:3838`
Default port: `3838` (override via `PORT` env)

## Authentication

Two methods, evaluated in order:

1. **Cookie session** — `cnst_session=<id>` (set by `/auth/login` and `/auth/register`). Browser default.
2. **Bearer API key** — `Authorization: Bearer cnst_<token>` (issued by `/auth/keys` or `/auth/invite`). Use for Postman / external tools.

Anonymous open mode (`AUTH_MODE=open`) bypasses auth on most read endpoints.

All bodies are JSON unless noted. All errors return `{ "error": "msg" }` with appropriate HTTP status.

---

## 1. Auth

### POST `/auth/register`
Public. Creates a user OR claims an invited placeholder.

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
200 + session cookie. 401 `Invalid credentials`. Rate-limited per IP and per email.

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
Creates an invited user + fresh API key, returns the plaintext key for the admin to hand off.
```json
{ "email": "teammate@x.com", "label": "designer" }
```
- New email → user row with `is_invited = 1` and a random placeholder password (claimable by the teammate via `/auth/register`).
- Existing email → reuses user, replaces api_key.

Response (201):
```json
{
  "api_key": "cnst_...",
  "user": { "id": "...", "email": "..." },
  "message": "Copy this key and share it securely — it won't be shown again."
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

### POST `/auth/promptowl`
SSO via PromptOwl. Used by web UI; not typically called from Postman.

### GET `/auth/admin-status`
Returns whether the caller is the license admin + license metadata.

### POST `/auth/device` / GET `/auth/device/poll`
Device-flow login.

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

---

## 3. Collaborators (direct nest sharing)

Separate from stewardship — this grants raw nest access. Stewardship layers governance on top.

### GET `/nests/:nestId/collaborators`
```json
{ "collaborators": [{ "id": "...", "user_id": "...", "email": "...", "permission": "read" }] }
```

### POST `/nests/:nestId/collaborators`
```json
{ "email": "c@x.com", "permission": "read" }
```
- `permission` ∈ `read` / `write` / `admin`.
- Auto-creates placeholder user (`is_invited = 1`) if email unknown.

### PATCH `/nests/:nestId/collaborators/:collabId`
```json
{ "permission": "write" }
```

### DELETE `/nests/:nestId/collaborators/:collabId`

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
    "content": "# md body"
  }]
}
```

### POST `/nests/:nestId/nodes`
```json
{
  "title": "Foo",
  "content": "# Foo\n\nbody...",
  "tags": ["api", "v2"],
  "type": "document",
  "scope": "team",
  "status": "draft"
}
```
- Slug derived from title → `nodes/<slug>`.
- If stewardship enabled → status defaults `draft`. Else `approved`.
- Auto-syncs tag index for steward resolution.

Response (201): `{ "node": { ... }, "stewards": [...] }`.

### GET `/nests/:nestId/nodes/:nodeId`
Full node content. 403 if no steward access (when stewardship on).

### PATCH `/nests/:nestId/nodes/:nodeId`
Headers (optional): `X-Base-Version: 3` — server returns 409 on conflict.
```json
{
  "title": "...",
  "content": "...",
  "tags": ["..."],
  "changeNote": "fixed typo"
}
```
Requires nest write permission.

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

## 8. Query / Search (read-only consumers)

These power LLM context retrieval. Open-mode friendly.

### GET `/nests/:nestId/search?q=<term>`
Full-text search.
```json
{ "count": N, "nodes": [{ "id": "...", "title": "...", "tags": [...] }] }
```

### POST `/nests/:nestId/context`
Body:
```json
{ "node_ids": ["nodes/foo", "nodes/bar"], "include_links": true }
```
Bundles requested nodes + their backlinks. Used by MCP / agent flows.

### POST `/nests/:nestId/query`
Graph query (Cypher-ish).

### GET `/nests/:nestId/overview`
Nest-level summary stats.

### GET `/nests/:nestId/context`
Returns CONTEXT.md content.

### POST `/nests/:nestId/publish`
Publishes the nest (snapshots + index).

---

## 9. MCP

### `/nests/:nestId/mcp/*`
Model Context Protocol endpoints — JSON-RPC over HTTP. Not exercised manually; LLM clients connect here.

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
