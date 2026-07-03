---
"@promptowl/contextnest-community": minor
---

v1.7.0 — anchored inline comments, delegated nest admins, nested folders, and a documented deterministic-retrieval API.

### Comments → anchored inline annotations

- **Replaces the comment modal with anchored inline threads** (`ui/src/components/AnnotationsPanel.tsx`, `ui/src/lib/anchor-highlight.ts`): highlight text in a markdown doc to pin a comment to that quote (W3C TextQuote anchor), painted via the CSS Custom Highlight API; click/hover a highlight to focus its thread in a sticky rail. A new comment-mode toggle forces the rendered read view so select-to-comment works without TipTap stealing focus. `CommentsPanel.tsx` and its modal trigger are deleted — no backend/schema change, reuses the existing `/annotations` service.
- **Postgres-safe annotation ordering** (`src/annotations/service.ts`) — `ORDER BY rowid` (a SQLite-only pseudo-column) replaced with `ORDER BY id`, a portable deterministic tiebreak.
- **`context_comments` gated on approval** (`src/mcp/tools.ts`) — the MCP tool resolved threads directly, bypassing the approved-only gate `context_get`/`context_export` enforce; an unapproved draft's quoted text and paraphrased comment bodies could leak through this side door. Now refuses with the same "no approved version yet" message as the other content tools.
- **Document list — sort by name, recency, or comment count** (`src/nests/routes.ts`, `ui/src/components/NestView.tsx`) — new `countThreadsByNode` aggregate and `GET /nests/:nestId/comment-counts` power a "Most comments" sort option alongside name and recently-edited.

### Delegated nest administration

- **Nest owner/admin collaborators can manage stewards, settings, and MCP sharing** (`src/governance/stewardship-service.ts`, `src/app.ts`, `src/mcp/tools.ts`, `ui/src/components/TeammatesPage.tsx`) — `canManageStewards` is now nest-aware (server admin OR nest owner/admin) instead of requiring the license admin; `PATCH /nests/:id/settings` and MCP `context_share_nest` now follow the same rule as REST, closing a prior TODO.
- **Follow-up hardening** (`f865dad`): the steward roster endpoint (`/nests/:id/stewards`) is excluded from public/anonymous read (was leaking steward emails/roles on anon-owned nests); disabling stewardship (which hard-deletes stewards and pending reviews) stays owner/server-admin-only so a delegated admin can't wipe governance state. Dead `canManageWith` removed from `src/governance/roles.ts`.

### Nested folders

- **Documents can be created at any depth under `nodes/`** (`src/nodes/service.ts`, `src/nodes/routes.ts`, `src/mcp/tools.ts`) — creation previously flattened everything to `nodes/<slug>`; `createNode` now accepts a per-segment-slugified `folder` (traversal chars collapse, empty segments drop, max 8 levels) via REST `POST /nodes` and MCP `context_create`.
- `DocumentEditor` gets a Folder field (datalist of existing paths); `NestView` groups its Contents list by full folder path with depth-indented headers instead of only the first path segment.

### Deterministic retrieval API

- **Connect modal — new API tab** (`ui/src/components/ConnectModal.tsx`) documents the previously-unlisted `POST /nests/:id/context` endpoint (selector + hops + max_tokens → assembled markdown with a hops_used/nodes_traversed trace), the selector grammar (`#tag`, `type:`, `[[Title]]`, `scope:`, `+AND`/`|OR`/`-NOT`), and 1-hop vs multi-hop semantics; the CLI tab cross-references it. MCP tab now lists all 21 registered tools (was undercounting at 18); snippets wrap instead of truncating, and open-mode snippets drop the now-unneeded auth flags.
- **`context_query`/`context_resolve` take a caller-set `hops`** (default 2, was hardcoded) with matching REST support, then hardened: `normalizeHops` treats `null`/`undefined` as the default instead of `0`, and caps depth at `MAX_HOPS=10`. Both tools are now routed through `resolveLlmBody` so hop-expanded neighborhoods can no longer surface unapproved/draft bodies — previously only `context_get`/`search`/`export` enforced that gate.
- **Graph click-to-query** (`ui/src/components/OntologyGraphView.tsx`) — clicking a node in the ontology graph surfaces its engine selector (`[[Title]]` / `#tag`) with a copy button and a 0-3 hop picker that drives both the highlighted neighborhood (BFS over visible links) and a matching copyable `POST /context` curl.
- **`[[Title]]` selector + hop-expansion hardening** (`src/nodes/query-routes.ts`) — a pure `[[Title]]` selector sent alongside `prompt` no longer gets silently overwritten; hop expansion now checks document status so drafts can't leak in via a neighbor 1+ hops from a matched title when `include_drafts` is off; id-style `[[nodes/some-id]]` wikilinks resolve in hop adjacency the same way the graph builder does.

### Accounts & auth

- **`POST /auth/invite` issues a temporary password, not an API key** (`src/auth/routes.ts`, `ui/src/components/TeammatesPage.tsx`) — invited teammates previously got an unusable placeholder password and could never log in with email + password. Re-inviting an unclaimed user now refreshes the temp password; an already-claimed user gets `409` (use Reset password) so a real login can't be clobbered.
- Login normalizes email via trim + lowercase, so autofill whitespace no longer 401s. Admin password reset no longer revokes the user's API key (independent credentials); sessions are still cleared.
- **Auth invite flow ported to the async DB adapter** (`src/annotations/service.ts`, `src/auth/routes.ts`) so it works against Postgres, not just SQLite.
- **Migration 012 — merge case-colliding user rows** (`src/db/migrations.ts`, `src/db/migrations.postgres.ts`) — pre-existing `Bob@x.com`/`bob@x.com` collisions (left behind by migration 009's NOCASE-unique constraint) resolved to different rows, so password resets and logins targeted the wrong account. The migration merges each case-insensitive email group into one winner and repoints every FK and email-keyed reference, then canonicalizes emails to lowercase. A follow-up fix corrected the steward dedup, whose correlated `EXISTS` self-matched every row in a collision group and deleted *all* active steward grants for the email instead of collapsing duplicates — a governance regression hidden inside the login fix.

### Nest dashboard

- **`GET /nests` tile metadata actually works** (`src/nests/routes.ts`) — was 500ing (`db.prepare` doesn't exist on the async DB adapter) and, once fixed, always reported 0 documents (missing `await` on `engineCache.get()`). Per-nest filesystem scans replaced with grouped queries over `node_versions`/`nest_collaborators`/`stewards`, so `Dashboard.tsx` nest tiles show accurate document/collaborator/steward counts with no per-load fs I/O.

### Tests

New/expanded coverage: `test/annotations.test.ts`, `test/context-endpoint.test.ts`, `test/db-postgres.test.ts`, `test/delegated-admins.test.ts`, `test/invite.test.ts`, `test/key-mode.test.ts`, `test/mcp-routes.test.ts`, `test/merge-colliding-users.test.ts`, `test/nest-tile-metadata.test.ts`, `test/nested-folders.test.ts`.
