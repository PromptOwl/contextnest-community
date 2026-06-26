# @promptowl/contextnest-community

## 1.3.0

### Minor Changes

- v1.3.0 — server super-admins, license-persistence hardening, document history pass, and internal-folder sync.

  ### Governance & access

  - **Server super-admins** (`access.yaml: super_admins`) now administer every nest — change visibility, manage collaborators, manage stewards — without being added per-nest. Owner-only operations (delete, transfer) still require the owner. Surfaced server-side in `src/governance/stewardship-service.ts`, `src/shared/access.ts`, and the nest routes.
  - **Public/private visibility toggle** is now on the nest header itself, not buried in a dialog. Reads as the source of truth for who can see the nest.
  - **Review queue surfaces submitted-for-review edits** so reviewers see the pending versions a contributor staged, not just net-new documents.

  ### License & onboarding

  - **`PROMPTOWL_KEY` now persists under `$DATA_ROOT/.env`** (was: `$cwd/.env`, which is root-owned `/app` in the official image and silently lost the key on container recreate). Surfaces write failures on the License Setup Page instead of failing silently. Override via `ENV_FILE_PATH`.
  - **Case-insensitive email** across registration, login, invite, and access checks — dedupes existing accounts on migration, fixes "I can't log in because I capitalized my email", and unblocks access-guard / lockout mismatches.

  ### Document workflow

  - **Version history + highlighted diffs** in the document detail view — every saved version is browsable, and an inline diff highlights what changed between any two versions.
  - **Nest Overview / index landing** — a grouped table-of-contents plus a "recently edited" strip lands every nest on a navigable index instead of a flat list.
  - **Hyperlink navigation fix** — hyperlinks in the editor / viewer now navigate to their configured target URL correctly.

  ### MCP & telemetry

  - **Internal-folder sync** (`src/nests/unsynced-service.ts`, new MCP tools): an external client can list the unsynced folders under a nest's filesystem vault and pull them into the nest on demand. Covered by `test/unsynced-folder.test.ts` and `test/mcp-unsynced.test.ts`.
  - **Telemetry batch_id + user email**: usage events now carry a stable `batch_id` (de-duped on the receiver) and the authenticated user email alongside the user id, so the `TheOwl` ingest bridge can meter credits to the right account.

  ### Repo / DX

  - **`CLAUDE.md`** added at the repo root with project-specific guidance for Claude Code (engine-boundary rule, command index, architecture map, key patterns).
  - **GitHub Actions** — `claude.yml` (PR assistant) and `claude-code-review.yml` (auto review on PRs) workflows shipped.

## 1.2.0

### Minor Changes

- bcd9fdf: Community usability + editor pass.

  Admin & auth (in-platform — no email server):

  - **Admin password reset** (`POST /auth/admin/reset-password/:userId`): set a user's password or generate a temporary one returned once for the admin to share; revokes the user's API keys + sessions. A self-service **Change password** action was added to the user menu so the recipient can set their own.
  - **Remove users** (`DELETE /auth/users/:userId`): revokes api keys, sessions, steward + collaborator rows, then deletes the account. Blocks self-delete and users who still own nests.
  - **`PROMPTOWL_SIGN_IN_GATE`** (`open` / `admin-only` / `disabled`): restrict "Sign in with PromptOwl" to the admin; everyone else uses email/password. Enforced server-side; the admin reaches it via `?admin=1`.

  Agents & governance:

  - **Plain-text view for agents** — `?format=markdown` on a node returns frontmatter + body as `text/markdown`.
  - **Steward version revert** (`POST .../revert`) restores an earlier version as a new one; a pending-review document is now editable (saving withdraws the review, matching server behavior).

  Editor: always-editable surface, selection bubble toolbar, turn-into, in-doc find & replace, wiki/code-safety fixes, and rich blocks (tables, callouts, toggles, syntax-highlighted code, columns).

- 73a022c: Wiki usability pass — the nest reads like a real wiki.

  - **Backlinks**: every document shows "Linked from N documents" (client-side reverse index over `[[wiki links]]`; zero server changes).
  - **Outline/TOC**: docs with 3+ headings get a clickable outline that scrolls to the section.
  - **Hover-preview**: hovering a `[[wiki link]]` in the read view shows the target's title + snippet, resolved from the already-loaded list.
  - **Multi-tag filtering**: tag chips on document rows are clickable and combine into an AND filter with a clear bar.
  - **Sharing clarity**: the document view's share button now says "Share nest" and the dialog states sharing applies to the whole nest (stewards restrict individual docs). New "Copy link" button produces a `?nest=&doc=` deep link, and the app's deep-link probe opens documents directly.
  - **Rename safety**: retitling a doc warns which `[[Title]]`-form links would break (slug links survive).
  - **Link health**: the document list reports broken links and orphan docs, each clickable.
  - **Recently edited**: a quick-access strip appears once a nest outgrows a glance (5+ docs).

### Patch Changes

- Post-changeset bug fixes rolled into v1.2.0.

  - **Editor toolbar overflow** — top content toolbar no longer overflows on narrow widths; bubble toolbar (selection format-on-highlight) is no longer obscured by the top toolbar on first/top blocks.
  - **Drag handle** — black dropcursor line no longer lingers briefly after release.
  - **Wiki links** — visible visual styling beyond underline (color + hover state); hover preview now triggers reliably; internal navigation path cleaned up.
  - **Change password modal** — UX polish; password change flow now blocks reuse of the current password.

## 1.1.0

### Minor Changes

- v1.1.0 — sharing, vault import, and governance release. Adds the ability to bring existing markdown into a nest, share nests with collaborators or the public, and brand the UI, alongside a governance and editor pass.

  ### Vault import

  - **Import an existing folder / vault** (`src/fs/vault-import.ts`, `ui/src/components/ImportFolderModal.tsx`): create a new nest from a folder of markdown files in one step — from the dashboard ("Import folder") or via the API. Frontmatter, `[[wiki links]]`, and folder structure are preserved. Covered by `test/import-nest.test.ts`.

  ### Sharing & visibility

  - **Per-nest sharing + collaborators** (`src/nests/sharing-service.ts`, `sharing-routes.ts`, `ui/src/components/ShareNestDialog.tsx`, `CollaboratorManager.tsx`): set a nest's visibility and add collaborators with read or write access. A Share affordance is now inline in the document view.
  - **Public read-only nests** (`visibility=public`): flip a nest to public to serve it to unauthenticated readers. The bypass applies to GETs only — write actions still require a valid key.

  ### Governance & stewardship

  - **Owner self-approve** — a nest owner can approve their own changes, replacing the previous per-nest toggle.
  - **Auto-approve toggle** — new per-nest option to auto-approve incoming changes.
  - **Role-based action gating** — UI buttons and actions now reflect the viewer's role; non-permitted actions are hidden rather than failing on submit.
  - **Steward scope editing** — stewards can edit scope during a role change; fixes the case where a steward role update did not allow scope modification.
  - **Stewardship service overhaul** (`src/governance/stewardship-service.ts`, `roles.ts`, `title-resolver.ts`): consolidated role handling, manage-own-record restriction, and a shared title resolver.
  - **MCP tools control logic** (`src/mcp/tools.ts`): reworked collaborator access actions and tool exposure to match the new permission model.

  ### Editor & UI

  - **Wiki linking** — `[[wikilink]]` autocomplete; clicking a broken link creates a new doc with the title pre-filled; tag chips filter the nest list.
  - **Document view** — Notion-style H1 title, click-to-edit, breadcrumb back navigation, and an unsaved-changes warning.
  - **Custom logo / branding** (`LOGO_URL`) — show your own logo in the UI header and login screen; invalid schemes fall back to the bundled icon.
  - **Error boundary** (`ui/src/components/ErrorBoundary.tsx`) — a render error in one view no longer blanks the whole app.

  ### Auth & fixes

  - Auth / license refactor (`src/auth/license.ts`, `routes.ts`, `keys.ts`) and login-flow fixes for external editors and public readers.
  - Review queue card now binds to the reviewable count instead of the raw queue.
  - Rate-limit, access-guard, and key-mode handling hardened; covered by expanded `test/governance.test.ts`, `security.test.ts`, and new `key-mode.test.ts`.
  - Bumped `uuid` to 14; added `@tailwindcss/typography`.

  ### Docs

  - README: new "What's new in 1.1.0", import / sharing / public-read / branding in the feature table.
  - CONFIGURATION.md: documented `LOGO_URL`.
  - `.env.example`: corrected `AUTH_MODE` default to `key`.

## 1.0.1

### Patch Changes

- 9d8d45a: v1.0.1 — bug-fix and polish release. Pulls in the new `@promptowl/contextnest-engine` document-hashing pipeline (external-edit detection, safe-publish, version diff), and clears a backlog of auth, license, governance, and UI issues found while dogfooding v1.0.0.

  ### Engine integration — document hashing

  Updated `@promptowl/contextnest-engine` integration to use the engine's content-hashing pipeline for change detection, conflict-aware saves, and AI-readable publish gating:

  - **External-edit detection** (`src/governance/external-edit-service.ts`, `ui/src/components/governance/ExternalEditBanner.tsx`): server compares the stored content hash against the on-disk hash on every read; when they diverge (file edited outside the UI), the editor shows an "External edit detected" banner with a side-by-side diff and a single-click "Adopt external edit" / "Keep my version" choice.
  - **Safe-publish** (`src/governance/safe-publish.ts`): publish actions now hash the candidate content and refuse to overwrite a newer base version. Replaces the previous "last-write-wins" path.
  - **Version diff** (`ui/src/components/governance/DiffViewer.tsx`, `VersionHistory.tsx`): version-history rows now render an inline diff against the previous hash.
  - **Lifecycle badge** (`LifecycleStatusBadge.tsx`): doc list/header surfaces the live lifecycle state (draft / under review / approved / external-edit) driven by engine hashes.
  - New backfill (`src/db/backfill.ts`) computes hashes for pre-existing documents on first boot of v1.0.1 — no manual migration required.

  ### Authentication & sessions

  - **Session not invalidated across tabs after logout** — `AuthContext` now broadcasts logout via `storage` events; every open tab clears its session immediately instead of holding a stale user object until the next refresh.
  - **PromptOwl login stuck on "Waiting for approval" after denial** — `Login.tsx` / `AdminLoginModal.tsx` now consume the denial response, surface a clear error, and reset the polling state so the user can retry without reloading.
  - **Login screen — password field missing show/hide (eye) icon** — added password-visibility toggle to the login form.
  - **Logout has no confirmation or success feedback** — added confirm dialog before logout and toast on success.

  ### License

  - **License revocation does not immediately block write actions** (`src/auth/license.ts`, `src/index.ts`) — the long-poll watcher now flips an in-process "writes blocked" flag synchronously on revoke, so the next non-GET request returns `503` instead of completing against a revoked license.
  - **Removed `PROMPTOWL_DEV_LICENSE_BYPASS` env var** — the bypass was added as a test-helper escape hatch, then leaked into production code paths. Tests now mint a real test license via `test/helpers.ts`; the bypass is gone from `src/config.ts` and `src/app.ts`.

  ### Governance & stewardship

  - **Manage delete event + user-role permission** — extracted nest-delete into a dedicated `DeleteNestDialog`, wired it through `App.tsx` / `Dashboard.tsx` / `NestView.tsx`, and tightened the steward / collaborator permission check in `src/nests/service.ts` so non-owners can no longer trigger destructive operations from a stale UI state.
  - **Removed folder-scope and approve/reject checkboxes from steward assignment** — the matrix UI implied per-action permissions that the server never enforced. Simplified `StewardAssignmentModal` / `StewardList` to role-only assignment; updated `API.md` and `STEWARDSHIP.md` to match.
  - **Document status management** — fixed `review-service.ts` so a doc moves to `approved` (not stuck in `under_review`) when stewardship is toggled off mid-flight; `NestView` re-fetches the lifecycle badge after the transition.

  ### UI / editor

  - **Render markdown nodes properly (`DocumentViewer` + view/edit toggle)** — new `DocumentViewer` component (react-markdown + remark-gfm + a small wikilink plugin) renders CLI/MCP-authored markdown correctly. Existing docs open in view mode; new docs in edit mode; toolbar toggles between them. Resolves "the nest should render markdown properly, and handle wiki cross-linking, today it does not."
  - **Correct edit and view mode** — fixed `DocumentEditor` so the view/edit toggle preserves unsaved changes and reflects the active mode in the toolbar.
  - **`MarkdownEditor.setContent` — pass `SetContentOptions` object** — adapted to TipTap v3 API; clears a console warning and a subtle cursor-jump bug.
  - **Clarify "publish" semantics in document editor + stewardship copy** — "Submit for Review" → "Publish (requires approval)" when stewardship is on; "Auto-published" badge when off; modal + settings help text aligned. Wording-only, no behaviour change.
  - **Connect modal — API-key rotation warning persists after rotation** — the stale warning is now cleared the moment the rotation succeeds.
  - **"Claim as Admin" button visible in OPEN mode** — hidden in open mode where the concept doesn't apply.
  - **Dashboard summary card now shows nests / documents / users** — new top-level `GET /stats` endpoint (`src/app.ts`) returns counts scoped to the caller's visible nests; dashboard renders three tiles instead of one, with `"—"` fallback when `/stats` is unavailable (older server / license gate).
  - **`NestSettingsModal` — Danger Zone (type-to-confirm delete)** — initial UI affordance for the already-existing `DELETE /nests/:nestId` route; superseded later in this release by the extracted `DeleteNestDialog`.
  - **Improvement — model list scroll + nest version display** — model picker is now scrollable on long lists; nest header shows the correct engine/community version pair.

  ### Docker / build

  - **Dockerfile: use npm to match shipped lockfile + bump to `node:22`** — the previous Dockerfile copied a non-existent `pnpm-lock.yaml`, breaking `docker build` immediately. Install now goes through npm against the shipped `package-lock.json`. Base image bumped to `node:22-slim` because the build script's pnpm step requires Node ≥ 22.
  - **`package-lock.json`** updated to reflect the engine and dev-dep changes; verified `npm ci` clean.

  ### Tests / infra

  - **Fix 14 broken integration tests on `main` (license + helpers)** — three stacked causes (license-gate 503s on every non-GET, `/auth/register` no longer returns `api_key`, `POST /auth/keys` now `409`s on duplicate). Helpers register and mint via `/auth/keys` explicitly; key-mode assertions realigned. Result: open-mode 13/13, key-mode 12/12, full community suite 118/118 passing.
  - **Fix governance test case** — corrected stale fixture data after the status-management fix above.

  ### CI / release

  - Added `Release` GitHub Actions workflow + Changesets configuration. (Auto-publish disabled until `NPM_TOKEN` is provisioned; this release was cut by `npm publish` locally.)

## 1.0.0

### Major Changes

- 032c7d2: v1.0.0 — first stable release of ContextNest Community Edition.

  **License & setup**

  - New **License Setup Page**: server boots into setup mode when no PromptOwl license is installed. Operator pastes a `pk_...` key in the browser; the server validates against PromptOwl, persists it to `.env`, and exits setup mode. Reads stay available while unlicensed; writes return `503` until activation.
  - **Live license revocation**: long-poll watcher against `app.promptowl.ai/api/license/listen` flips the server back into setup mode within seconds of a revoke — no restart required.
  - **Admin identity derived from license**: the admin user is whichever PromptOwl account owns the currently-installed license, resolved live per request. Transferring the license to a new account immediately promotes the new owner and demotes the old one (replaces the previous static `users.is_admin` flag).

  **Auth**

  - **Cookie-based web sessions**: browser auth now uses an `httpOnly` session cookie set on `/auth/register`, `/auth/login`, and `/auth/promptowl`, and cleared on logout. Replaces the previous localStorage-token flow. CLI / Claude Desktop / MCP clients continue to use Bearer API keys — unchanged.
  - **Invited-user claim flow**: emails added via nest-share or steward-assignment create a placeholder user row (`is_invited = 1`). When that email later registers, the existing row is claimed in place, so all pre-assigned nests and stewardship roles carry over.
  - New `AuthContext` provider on the frontend with stale-fetch protection so rapid login/logout cycles cannot clobber state.

  **Editor**

  - New **Document Editor** page (TipTap markdown) replacing the old textarea. Adds:
    - Tags and conflict-aware save (`409` with rejected content preserved when base version is stale).
    - Internal wiki links via `[[` and a Document Picker modal, rendered as `nest://...` references.
    - Mentions and interactive task checkboxes.
    - In-editor governance actions (Submit for Review / Approve / Reject) when stewardship is enabled on the nest.

  **Governance**

  - **Steward = collaborator**: assigning a steward now also creates the matching `nest_collaborators` row so the assigned user can see the nest in their dashboard. Editors get `write`, reviewers/viewers get `read`.
  - Fixed folder-scope steward resolution so a folder pattern at the nest root matches the document at that exact path, not only nested sub-paths.

  **API & docs**

  - New top-level `API.md` (~520 lines) documenting the full REST surface, request/response shapes, and error codes.
  - Clearer error messages across auth, license, and conflict responses.

  **Internal**

  - Switched build script from `pnpm` to `npm` to align with the package-lock-based toolchain.
  - Added `@changesets/cli` + `@changesets/changelog-github` and the `Release` GitHub Actions workflow for npm publishing.
