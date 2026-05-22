# @promptowl/contextnest-community

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
