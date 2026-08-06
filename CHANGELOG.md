# @promptowl/contextnest-community

## 1.15.0

### Minor Changes

- a6661ff: Native PromptOwl connection: accept the short-lived `scope: "mcp"` service
  ticket on the per-nest `/nests/:id/mcp` transport (in addition to `/index`,
  server-level `/mcp`, `POST /context`, and `GET /nodes`), so a PromptOwl block
  granted read & write on one nest can reach that nest's write tools. Add two
  server-level bootstrap writes — `nest_create` and `context_create` — to the
  cross-nest `/mcp`, each gated by the same per-user write checks, suspend
  kill-switch, and license gate the per-nest path enforces. The MCP ticket and
  the one-click SSO login ticket are now mutually exclusive: `/auth/sso` refuses
  an `mcp`-scoped ticket and the MCP middleware refuses a ticket carrying a
  `jti`.
- e675f73: Prime documents: a per-document and per-tag review gate, so a nest no longer
  has to choose between reviewing everything and reviewing nothing. A **prime**
  document always goes through draft → pending → approved — it is the one thing
  `allow_self_approve` does not bypass, so even an owner's edit to the sales
  playbook lands as a draft.

  Whether a document is prime resolves in the existing steward scope order,
  **document → tag → nest**: a Prime switch in the document editor (owner/admin
  only, where `false` exempts one doc from an otherwise-prime tag), then the
  nest's configurable prime tags (`prime-document` by default), then not prime.
  A new per-nest `prime_only_review` setting flips a governed nest's default to
  self-publish so only prime documents queue for review; it is off by default, so
  existing nests keep their current posture on upgrade. Prime documents carry a
  badge in the nest's document list, and both settings are exposed on
  `GET`/`PATCH /nests/:id/settings` alongside `prime` on node create/update.

- Deletion requests as a first-class governance flow, a configurable maturity
  board with a reworked nest workspace, and MCP delete/move tools backed by a
  node-create path that no longer races itself.

  ### Deletion requests

  - **Request deletion of a document, folder or nest** (`src/db/migrations.ts`, `src/db/migrations.postgres.ts`, `src/governance/review-service.ts`, `src/governance/routes.ts`, `src/app.ts`) — a member without delete rights no longer has to ask an admin out of band. A new `deletion_requests` table keyed by target type carries the request through the same approve/reject vocabulary as a review, with the target resolved segment-aware so a folder named `policy` never matches `policies/` (`src/governance/title-resolver.ts`). Honouring the folder on approval is gated behind owner/admin, so a reviewer can clear a request without cascading a delete they were never entitled to.
  - **One Delete action, permission picks the dialog** (`ui/src/components/NestView.tsx`, `ui/src/components/DocumentEditor.tsx`, `ui/src/components/governance/ReasonDialog.tsx`, `ui/src/components/Dashboard.tsx`) — the same button either deletes or opens a reason prompt depending on what the caller may do; authors can delete their own documents outright, and a target with a request already open shows a pending badge to the requester instead of appearing untouched.
  - **Notifications on both ends** (`src/governance/notify-service.ts`, `src/notify/dispatch.ts`, `src/notify/email-render.ts`, `src/db/backfill.ts`) — admins hear about a new request, requesters hear the verdict. A one-shot backfill fills in notification titles that predate the change so old rows don't render blank.
  - **Same flow from an agent** (`src/mcp/tools.ts`) — a deletion an MCP client isn't permitted to perform is filed as a request rather than refused.

  ### Nest workspace

  - **Configurable maturity board** (`ui/src/components/MaturityBoard.tsx`, `ui/src/lib/board-dimensions.ts`) — a per-nest board that groups documents by lifecycle status, folder, or tag, with drag-to-move on the folder dimension. Columns come from the real lifecycle statuses rather than an invented set, and folder keys drop the `nodes/` prefix so the headers read as paths a user recognises.
  - **View switcher and a shared page header** (`ui/src/App.tsx`, `ui/src/components/NestPageHeader.tsx`, `ui/src/components/NestView.tsx`) — Documents, Board, Graph, Definitions and Workflows share one header and one spacing scale instead of each page inventing its own.
  - **Search moved into the header** (`ui/src/App.tsx`) — reachable from every nest page instead of only from the Documents list.
  - **Clickable tags and breadcrumbs** (`ui/src/App.tsx`, `ui/src/components/DocumentEditor.tsx`, `ui/src/components/OntologyGraphView.tsx`) — a nest-scope enabler lets a tag or breadcrumb segment navigate back into a filtered document list.
  - **Documents default to "Recent activity"** (`ui/src/lib/node-sort.ts`, `ui/src/components/NestView.tsx`) — the list opens on what changed last rather than alphabetical order.

  ### MCP & node integrity

  - **`context_delete` and `context_move`** (`src/mcp/tools.ts`, `src/nodes/service.ts`) — agents can delete and move documents through the same permission checks the REST routes enforce; an ambiguous title is refused rather than resolved to a guess. Resolving a node by id now hits the record directly instead of scanning the vault.
  - **Create no longer collides with itself** (`src/nodes/service.ts`) — creates serialize per node id and fail closed on the id check, a create that would collide with an existing node is refused, node-keyed rows no longer outlive the document they described, and the move-destination and duplicate-title races are closed.
  - **Approvers can move and delete a node under review** (`src/nodes/service.ts`) — the review lock stopped the one role able to resolve the review.
  - **Authors can find their own unsubmitted drafts** (`src/governance/version-service.ts`, `src/app.ts`, `src/mcp/tools.ts`, `ui/src/components/Dashboard.tsx`) — a draft that was never submitted was invisible to everyone including the person who wrote it.
  - **Document titles bounded at 120 characters** (`src/nodes/service.ts`, `ui/src/components/DocumentEditor.tsx`) — an unbounded title overflowed the breadcrumb and every list that rendered it.

  ### Fixes

  - The write path records why it skipped review instead of guessing a reason (`src/nodes/service.ts`, `src/nests/service.ts`).
  - Wiki links resolve by id, title or slug inside the review modal, matching the editor (`ui/src/components/NestView.tsx`).
  - Server timestamps without a zone read as UTC rather than local time (`ui/src/lib/dates.ts`).
  - The document title field is labelled and marked required instead of looking like static text (`ui/src/components/DocumentEditor.tsx`).
  - Long board card titles wrap instead of overflowing their column (`ui/src/components/MaturityBoard.tsx`).
  - Entering a nest folder-scoped opens Documents rather than the last view (`ui/src/components/NestView.tsx`).

- ba11aba: Per-version change logs instead of full-body copies. The version list
  (`GET /nests/:id/nodes/:nodeId/versions`) now returns each version's stored
  unified diff rather than reconstructing every body — opening the history panel
  of a long-lived document no longer replays the whole chain once per row and
  ships N full copies of the text. One body is fetched on demand from the new
  `GET /nests/:id/nodes/:nodeId/versions/:version`, which answers `200` with
  `content: null` when a version's chain can no longer be replayed, so one
  unreadable row doesn't fail the panel.

  Three fixes ride along. Draft saves now number through the engine's
  `nextVersion()` instead of the SQLite row count, closing the case where a DB
  lagging `history.yaml` grafted a second chain onto the first (duplicate
  versions, overwritten keyframes, "(no content)" from the graft point on) — a
  gated one-shot startup pass re-anchors documents already in that state and
  moves inline patches out into standalone `v{N}.diff` files. A duplicate
  `/versions` handler that shadowed the governance route is removed, so
  `resolvedBy` reaches the UI. And the diff viewer's line numbers no longer skip
  two, having learned to read the engine's `Index:` / `===` preamble as a header.

  Both version endpoints now take the same node-level read check as the document
  itself (`403` when the caller can't read the node). The list handler never had
  it, so on a public nest an anonymous reader could pull the change logs — and,
  through the new per-version endpoint, the reconstructed body — of a document
  that never cleared review, bypassing the approved-only rule public reads are
  otherwise held to.

  Requires `@promptowl/contextnest-engine` 1.3.0.

### Patch Changes

- 9447efe: Moving a document that isn't published no longer fails. A document stored with
  an empty tag list reads back with an undefined `tags` value, which the YAML
  serializer refuses to write — so every draft and pending-review move errored out
  while published documents (already cleaned by the publish path) moved fine. The
  same clean now runs on every write of a document that came from storage, which
  also covers the two import paths that reset a broken version chain or persist
  import metadata. The Documents list stops hiding "Move to folder" on a document
  awaiting review: owners, admins, and reviewers assigned to it are the callers the
  server already lets move one, and they now see the action.

## 1.14.0

### Minor Changes

- v1.14.0 — Microsoft Teams notifications, direct email to the people an event concerns, portable nest export/import, drag-and-drop document moves, and authors editing their own pending reviews.

  ### Notifications

  - **Microsoft Teams connector** (`src/notify/msteams.ts`, `src/notify/webhook.ts`, `src/notify/dispatch.ts`, `ui/src/components/SettingsPage.tsx`) — a second server-wide connector at full parity with Slack: the same governance events (review requested / approved / rejected, collaborator added, per-nest burst digests) post to a Teams channel as Adaptive Cards, configured via `MSTEAMS_WEBHOOK_URL` or the Settings card. Per-nest connector rows accept `channel: "teams"` with the same per-event filtering and `env:KEY` URL indirection as Slack. Delivery is fire-and-forget with a short timeout so a Teams outage never slows or fails the action that triggered it, and every user-controlled string in a card is escaped so a nest or document name cannot inject markup or links. The setting is named `msteams_*` because "teams" already means user groups in this product. `CONFIGURATION.md` documents creating the webhook through the Workflows (Power Automate) app, since Microsoft retired the classic Office 365 incoming-webhook connectors.
  - **Send test on the connector cards** (`src/app.ts`, `src/notify/webhook.ts`, `ui/src/components/SettingsPage.tsx`) — new `POST /admin/settings/test-notification` posts a message to the saved Slack or Teams webhook and reports whether it landed (200, 502 with the webhook's own reason, 400 for an unknown channel), so an admin can confirm a hook without waiting for a real governance event. The test renders through the same `formatBody` the live paths use, so what you see in the test is the real wire format. The route is gated on `serverAdminAllowed` — the same guard as reading and saving the webhook — instead of the license-admin-only check that previously 403'd a superadmin who could edit the URL but not test it.
  - **Emails go to the person the event concerns** (`src/notify/email.ts`, `src/notify/email-render.ts`, `src/governance/notify-service.ts`, `src/auth/routes.ts`, `src/nests/sharing-service.ts`, `src/governance/stewardship-service.ts`) — until now every notification email went to the shared `NOTIFY_EMAIL_TO` team inbox. A new direct-recipient send path emails the individuals involved: the invitee gets their nest invite (plus a Hootie inbox row surfaced by ContextNest Desktop), a new teammate gets their sign-in email carrying the one-time temporary password, every newly-assigned steward is told their role and scope, reviewers are emailed on submit, the submitter is emailed the verdict, and team members are emailed when their team is shared onto a nest. The per-status email copy collapsed into one status-keyed template table and the "shared" copy now addresses the recipient in the second person. All sends are best-effort — a dead SMTP never fails the invite, share, or review. The SMTP path gained a connection pool, a per-second rate limit, and backoff retry on provider throttle replies so a reviewer fan-out cannot trip a "too many emails" 550.
  - **Email sign-off** (`src/notify/email-render.ts`) — the "Automated governance notification" footer is gone and emails sign off as Community Nest.

  ### Nest portability

  - **Export a nest as a portable bundle** (`src/nests/bundle-service.ts`, `src/nests/routes.ts`, `ui/src/components/ConnectModal.tsx`) — `GET /nests/:id/export?format=bundle` (owner/admin) streams a `.zip` of the nest's documents plus engine version history (`.versions`) and nest config, so a nest can move to another ContextNest host. Documents are serialized from their approved/published state so they re-import published rather than as drafts; `?includeDrafts=1` also ships unapproved drafts, offered as an "Include draft documents" toggle in the Connect dialog's new Export dialog. Identities, attribution, and the governance overlay (stewards, reviews, comments, definitions, edges, grants) deliberately do not travel — the importer owns and re-governs the new nest. When an approved version cannot be reconstructed the document is skipped rather than shipping working-copy bytes stamped `status: published`.
  - **Import a bundle through the existing importer** (`ui/src/components/ImportFolderModal.tsx`, `ui/src/lib/markdown-split.ts`, `src/fs/vault-import.ts`) — the Import dialog gains a source selector (folder vs file) whose file picker accepts an exported nest `.zip` (expanded client-side), loose markdown/text files, or a whole-nest "Export as markdown" file split back into individual documents. Everything routes through the existing `POST /nests/import`; there is no second endpoint. `.context` is allowed alongside `.versions` through the import path so nest config and version history survive the round trip.

  ### Governance

  - **Authors can revise their own pending-review submissions** (`src/nodes/service.ts`, `src/governance/review-service.ts`, `src/shared/node-write-lock.ts`, `ui/src/components/DocumentEditor.tsx`) — submitting a document used to lock its own author out with a 423 until a steward ruled, forcing withdraw-and-resubmit to fix a typo. The author may now keep editing: the edit lands as a new draft version through the engine's normal hash-chain append and the open review repoints onto it — same review row, no re-notify, no duplicate — so the steward reviews the final edited version. Non-authors stay locked, and an auto-publishing owner editing their own pending review stays in review rather than self-approving past it. The repoint runs in a single transaction so the review pointer and version status can never disagree, and the editor shows the author a "still under review" notice while they revise.
  - **Review resolution serialized against author edits** (`src/shared/node-write-lock.ts`, `src/governance/review-service.ts`, `src/governance/routes.ts`, `src/mcp/tools.ts`) — approve/reject/cancel now take the same per-node write lock as `updateNode` and read the current version inside it, instead of resolving against a version read in the route before the operation ran. A concurrent author edit can no longer land between the read and the resolution, orphaning the fresh revision. REST and MCP approve/reject also echo the version actually resolved rather than a stale pre-read.

  ### Documents

  - **Drag-and-drop documents into folders** (`ui/src/components/NestView.tsx`) — drag a document onto a folder to move it, with a loading toast that swaps to success carrying an Undo action, and a keyboard-accessible "Move to folder" menu item and dialog behind the same mover so the flow is not drag-only. Document rows act as drop proxies for the folder they sit in, hovering a collapsed folder for ~600ms springs it open so nested targets are reachable mid-drag, and invalid targets (a document's current folder) show the no-drop cursor instead of highlighting. Move permission mirrors the edit gate exactly — stewardship scope plus the pending-review lock. Folder-onto-folder is intentionally not implemented: the server moves one document per call, so it would be N non-atomic moves.

  ### Fixes

  - **Discard actually discards** (`ui/src/components/DocumentEditor.tsx`, `ui/src/lib/draft.ts`) — blur-autosave wrote to the server, and blurring a field to click the back arrow fired that write before the "Unsaved changes" dialog appeared, so Discard only navigated away and left the edit saved (and spun up one version per field exit). Blur now parks edits in localStorage; the server is written only on an explicit Save or Save-and-leave, and Discard clears the parked draft and reverts to the loaded snapshot. Reopening a document restores its draft only when it was taken from the version just loaded — a newer server copy wins — and the draft store evicts the stalest other draft to fit, reporting failure so the editor can warn that a reload would lose the edits.
  - **Toggle blocks render a working disclosure control** (`ui/src/components/MarkdownEditor/editor-styles.css`, `ui/src/components/MarkdownEditor/extensions/Toggle.ts`) — TipTap renders a `div[data-type="details"]` rather than a native `<details>`, so the CSS targeting `.ProseMirror details` never matched: the chevron had no styling and the summary fell back to a list-item disc, reading as a stray bullet with no way to expand. The CSS retargets the data attribute, the chevron rotates on open, and a single click on the summary header toggles the block (double-click still edits the header text).
  - **Slack review events no longer post twice** (`src/notify/dispatch.ts`) — review events fired down both the immediate dispatch path and the debounced digest, and both hit the same server-wide Slack webhook. The implicit server-slack connector now carries the same digest guard Teams already had, so the digest owns review events and dispatch keeps only `run_failed`.
  - **Direct-recipient emails stay out of the team digest** (`src/notify/notify.ts`) — the email opt-out was all-or-nothing per debounce window, so an invite or verdict sharing a window with a non-skipped event still had its line folded into the team digest. The digest body is now built from non-skipped events only; Slack and Teams still receive everything.
  - **Multi-recipient emails use Bcc** (`src/notify/email.ts`) — a reviewer fan-out or team share put every address in the To header, leaking the roster to every recipient. Two or more recipients now go out via Bcc; a single recipient is unchanged.

  ### CI

  - **Auto-deploy dev on merge to development** (`.github/workflows/deploy-dev.yml`) — a workflow that builds the image and deploys the `community-nest-dev` Cloud Run service when a PR merges into `development`, mirroring the manual `deploy-dev.ps1` step for step (service account, GCS nest volume, Cloud SQL, VPC, scaling, public access). Secrets moved out of the script into `DEV_*` repository secrets, leaving `PROD_*` free for a later main pipeline; deploys serialize rather than cancelling in flight so a second merge cannot interrupt a docker push or Cloud Run rollout mid-way.

## 1.13.0

### Minor Changes

- v1.13.0 — dashboard cleanup, faster My Work, governance auto-publish, and safer email/upload handling.

  ### Governance

  - **Auto-publish owner & admin edits** (`src/nodes/service.ts`, `ui/src/components/NestSettingsModal.tsx`) — the nest "Allow self-approve" flag is redefined as an owner/admin governance bypass: with it on, create/update by an owner or admin publishes immediately instead of landing as a draft awaiting review. Editors and reviewers are unchanged (still draft → submit → review). Applies across REST and MCP via the shared node service, respects the pending-review edit lock, and the setting is renamed to "Auto-publish owner & admin edits".
  - **Approval inbox hidden from non-approvers** (`src/governance/review-service.ts`) — the `/me/work` "waiting on me" bucket previously listed pending reviews from nests where the caller was only an editor or viewer, showing an Approve/Reject affordance the server would reject. It is now filtered to nests the caller can actually approve in, resolved per distinct nest and cached briefly so the polled inbox stays cheap.

  ### Dashboard & My Work

  - **Nests and My Work in tabs, faster load** (`ui/src/components/Dashboard.tsx`, `ui/src/lib/api.ts`) — dashboard annotate runs in parallel and My Work uses a single visible-nests query with a scoped review queue and paginated inbox.
  - **Delete unwanted unsynced folders** (`src/nests/unsynced-service.ts`, `src/nests/routes.ts`, `ui/src/components/Dashboard.tsx`) — new `DELETE /nests/unsynced/sync` (server-admin gated, same safe-name and live-nest-root guards as sync) plus a confirmed Delete button on each unsynced card, so leftover imports can be removed instead of only synced.
  - **Importer + date on imported nest cards** (`ui/src/components/Dashboard.tsx`) and the stray "0" / duplicate Overview stat tiles on non-imported cards are gone.

  ### Teammates & nests

  - **Teammate list polish** (`ui/src/components/TeammatesPage.tsx`) — a "You" badge, search, and role filter.
  - **Private nests stay private** (`src/nests/service.ts`) — admins no longer see other users' private nests in the list.

  ### Fixes

  - **Email validation hardened** (`src/config.ts`, `src/auth/routes.ts`, `ui/src/components/*`) — `isEmailish` delegates to zod's email validator (rejecting junk like `*'/*'/8////@gmail.com`) while keeping the explicit CR/LF reject to close header-injection shapes; the UI validates email before adding a collaborator, steward, or team member.
  - **Video upload cap** (`src/config.ts`, `src/nests/asset-routes.ts`) — default 30 MB, configurable via `VIDEO_MAX_MB`, kept under Cloud Run's request-body limit so oversized videos fail with a clear message instead of a bare 413.
  - **Editor** (`ui/src/components/MarkdownEditor/MarkdownEditor.tsx`) — usable "Turn into Toggle" and the block menu survives paste.
  - **Draft publish-in-place** (`src/nodes/service.ts`) — upsert the version on publish-in-place to avoid a UNIQUE clash.
  - **Postgres counts** (`src/governance/review-service.ts`, `src/nests/service.ts`) — review-queue and nest-list totals are coerced to `Number` so counts are correct on Postgres.

## 1.12.0

### Minor Changes

- v1.12.0 — reliable external MCP connections, a tabbed dashboard, and a UI read cache that ends the constant reloading.

  ### MCP & connections

  - **Collaborator MCP connections unblocked** (`src/app.ts`, `src/mcp/tools.ts`, `src/auth/routes.ts`, `ui/src/components/ConnectModal.tsx`) — external clients (PromptOwl, Claude Desktop, Cursor) intermittently showed "no tools found" for users with valid access. The per-nest transport gate now runs at read tier (MCP Streamable HTTP is always POST; mutating tools re-check their own permission inside `runTool`), middleware denials on the MCP path return a proper JSON-RPC error envelope with an actionable reason instead of plain `{error}` JSON, and the Connect dialog mints a user-level key instead of silently nest-scoping the account's single key (rotate accepts `nest_id: null` to clear a stale scope). Backed by a full role-permission matrix suite (`test/mcp-permission-matrix.test.ts`).

  ### Dashboard

  - **Nests and My Work split into tabs** (`ui/src/components/Dashboard.tsx`) — with a large review backlog the stacked My Work list pushed the nest grid below a huge scroll; nests stay the default tab.
  - **Faster dashboard load** (`ui/src/components/Dashboard.tsx`, `ui/src/lib/api.ts`) — banner counts derive from the nest list's `document_count` instead of the slow `/stats` round-trip, and `/unsynced` + `/me/work` no longer gate the page loader; they stream in as they land.
  - **AI Ready card no longer shows 0 for live documents** (`ui/src/components/Dashboard.tsx`) — the count now includes `published` alongside `approved`, matching `LifecycleStatusBadge`.

  ### UI read cache

  - **Structural nest reads cached** (`ui/src/lib/api.ts`) — a 30s in-memory cache with in-flight dedupe for the slow-changing GETs (`listNodes`, `listNests`, `getNest`, `getNestSettings`) stops large nests from re-fetching everything on every navigation. True stale-while-revalidate (expired entries paint instantly and revalidate in the background), a generation counter closes the stale-after-edit race, and any successful mutation under `/nests/{id}` — including streaming import and folder sync — busts the affected cache plus the nests list. The cache clears on every auth transition so a user switch is never served the previous identity's data (`ui/src/auth/AuthContext.tsx`). Live document bodies, search, and feeds are intentionally uncached.

  ### Fixes

  - Invited badge cleared on every sign-in flow — PromptOwl device flow, SSO ticket, and OIDC logins left `is_invited=1`, so a stale badge lingered and a later re-invite could clobber an active account; the clear moved into `createSession`, the one point all browser sign-ins route through (`src/auth/sessions.ts`).

## 1.11.0

### Minor Changes

- v1.11.0 — teams as shareable member groups with PromptOwl sync, OIDC SSO, a governance activity feed, superadmin management from the UI, video assets, and type-appropriate editors.

  ### Teams & sharing

  - **Teams — shareable member groups with per-member roles** (`src/governance/teams-service.ts`, `src/governance/team-routes.ts`, `src/nests/nest-team-routes.ts`, `ui/src/components/TeamsPage.tsx`, `ui/src/components/TeamShareManager.tsx`) — teams as first-class member groups, attachable to nests from the share dialog with per-member roles and team-aware access resolution. Management is role-gated, roster writes are atomic against the resolved account email, and sharing a team onto a nest requires editor+ plus a relationship to the team (view-only members can no longer attach a team the owner can't undo).
  - **PromptOwl team import + one-click sync** (`src/governance/promptowl-teams.ts`, `ui/src/components/PromptowlTeamsPanel.tsx`) — import PromptOwl teams into Community and keep them synced with one click, gated behind a `PROMPTOWL_TEAMS_ENABLED` settings flag with live-refreshing settings.

  ### Authentication

  - **OIDC SSO — Microsoft Entra ID + Google** (`src/auth/oidc.ts`, `ui/src/components/Login.tsx`, `ui/src/components/SettingsPage.tsx`) — superadmin-configurable OIDC sign-in with issuer presets, RP-initiated logout, graceful JIT provisioning, RS256 pinning, an `email_verified` policy, per-endpoint rate limits with fetch timeouts, and an SSO-only sign-in configuration.
  - **Department auto-tagging** (`src/config.ts`, `src/nodes/service.ts`) — optional department tags sourced from the OIDC department claim, with case-insensitive dedupe; claim capture never fails login.

  ### Governance & admin

  - **Activity feed in the review queue** (`src/governance/feed-service.ts`, `ui/src/components/governance/ReviewQueue.tsx`) — comments join changes in the review queue, with a counts-driven chip, load-more paging, parallel `canReview` resolution, and a feed license gate.
  - **Superadmin management from the UI** (`src/app.ts`, `ui/src/components/TeammatesPage.tsx`) — DB-backed grant/revoke of superadmins inline on the user card; superadmin peers are protected from reset/remove, grant races return 409, and revoke is hidden on your own row.

  ### Documents & editor

  - **Video assets + editor media upload** (`src/nests/asset-routes.ts`, `ui/src/components/MarkdownEditor/MarkdownEditor.tsx`, `ui/src/components/DocumentViewer.tsx`) — nest assets accept mp4/webm video alongside images with per-type size caps (images 10 MB, video 100 MB) enforced without raising the global request cap; the editor's Upload menu becomes "Image or video" with drag-drop, and both editor and read view render same-origin asset video URLs as an inline player. Asset serving sends `X-Content-Type-Options: nosniff`.
  - **Type-appropriate editors** (`ui/src/components/TableSourceEditor.tsx`, `ui/src/lib/csv-table.ts`) — source editing for tool and table nodes, with spreadsheet paste, CSV/TSV upload via a shared upload helper, and the editor locked during in-flight uploads.
  - **Raw node fetch** (`src/nodes/routes.ts`, `src/shared/artifact-sandbox.ts`) — `?format=raw` returns node bodies directly, with artifact responses sandboxed and `nosniff` on every raw path.
  - **Author + collaborators on documents** (`ui/src/components/AuthorshipChips.tsx`) — author and collaborator chips on document cards and details; the roster is withheld from public readers.
  - **Nest rename** (`ui/src/components/RenameNestDialog.tsx`) — rename a nest from the dashboard or nest view; the dialog sends only dirty fields and no longer clobbers an in-flight inline rename.

  ### Settings

  - **Per-type content toggles** (`src/config.ts`, `ui/src/components/SettingsPage.tsx`) — enable/disable content types server-wide, enforced on the bulk publish path and noted in the MCP `context_create` description; the workflow plane is labeled Beta (`ui/src/components/ui/beta-badge.tsx`).

  ### Fixes

  - Folder import recovers unpublishable docs, drops stale governance state, and shows progress; recovered docs land as `pending_review` without a refetch flash (`src/fs/vault-import.ts`, `ui/src/components/ImportFolderModal.tsx`).
  - Shared safe-copy clipboard util with a fallback for insecure contexts, applied everywhere including `CodeBlock` (`ui/src/lib/clipboard.ts`).
  - Workflow canvas shelf reflows to the visible width instead of clipping right-side cards (`ui/src/components/WorkflowsView.tsx`).
  - Nest description fields use a textarea and expand for long text; the nest Overview shows the real edited-this-week count; Overview and External Edits tabs show a loader while fetching (`ui/src/components/NestView.tsx`).
  - Collaborator chips are coloured per person so initials stop colliding; the redundant creator avatar beside the full email is dropped.

## 1.10.0

### Minor Changes

- v1.10.0 — a live workflow canvas with schedules and claimable runs, a data-driven connector/trigger layer, governed CSV tables, documents-as-a-repo folders, artifact version history, and configurable trace retention.

  ### Workflow orchestration

  - **Live workflow canvas** (`ui/src/components/WorkflowsView.tsx`) — an n8n-feel canvas wired to the edges API, with a 2-tab model (Canvas | Activity), a canvas shelf search, and grab-as-context commands. Replaces the standalone Runs and Edge-Types pages, which are folded into the canvas surface.
  - **Schedules** (`src/workflow/schedule-routes.ts`, `src/workflow/scheduler.ts`) — a Schedules tab separate from Runs, backed by a server-side scheduler.
  - **Claimable run queue** (`src/workflow/run-routes.ts`) — `?unclaimed=true` plus `GET /runs/:id/bundle` let external runners claim and pull work; run inputs, review-verdict notifications, and failed-run errors surface in the list.
  - **Sub-agent controls** — a dedicated Run tab with a sub-agent tree and upfront cap validation, a richer parent-run picker on the Run trigger form, and admin-editable sub-agent recursion caps driven from the server (`src/config.ts`, `ui/src/components/SettingsPage.tsx`).
  - **Tool node type + HITL watchers** (`src/workflow/run-routes.ts`, `src/workflow/env-routes.ts`) — a tool node type, a per-nest env store, and human-in-the-loop watcher notifications.

  ### Connectors & triggers

  - **Connector dispatch engine** (`src/notify/dispatch.ts`, `src/notify/connector-routes.ts`) — channels modeled as data, one brick per direction, surfaced as a connectors card in Activity and on the agent panel.
  - **Inbound trigger hooks** (`src/workflow/hook-routes.ts`) — tokenized listener URLs with platform presets for inbound triggers.
  - **Email connector** (`src/notify/email.ts`) — SMTP dispatch with credential verification before save.

  ### Governed tables

  - **Table content type** (`src/tables/service.ts`, `src/tables/query.ts`) — CSV as a governed, deterministically queryable fact store.
  - **CSV/TSV input** (`ui/src/lib/csv-table.ts`, `ui/src/components/TableViewer.tsx`, `ui/src/components/MarkdownEditor/TableControls.tsx`) — table input via CSV/TSV paste and file upload, with CSV round-trip and a large-table fallback.

  ### Documents as a repo

  - **Folder tree + move API** (`src/nodes/service.ts`, `ui/src/components/FolderTree.tsx`) — documents as a real repo: folder tree with drag-and-drop, a move API that relocates a document (and everything under it) to another folder, a breadcrumb folder picker, type-icon chips, and a nestable New Folder dialog.

  ### Artifacts

  - **Artifact version history** (`ui/src/components/ArtifactViewer.tsx`, `ui/src/components/governance/VersionHistoryModal.tsx`) — version history, preview, rollback, and source editing, with preview cache-busting on restore.

  ### Telemetry

  - **Configurable trace retention** (`src/telemetry/trace-log.ts`) — configurable retention plus a per-nest steward trace view, backed by an `api_events(nest_id, id)` index for per-nest trace queries.

  ### Settings & configuration

  - **Server settings in the database** (`src/db/settings.ts`, `src/config.ts`) — every server option lives in Settings (Anthropic key, Slack connector, public base URL); server settings and the license key persist to the DB instead of an ephemeral `.env`. A `MANUAL_SIGN_IN` flag gates email/password sign-in separately from PromptOwl.

  ### Engine convergence (Phase 0)

  - **Engine sync + MCP guard** (`src/mcp/tools.ts`, `scripts/check-mcp-schemas.mjs`) — engine 1.2.1 bump with the engine/CLI sync discipline, a per-node access gate enforced on MCP retrieval (`resolveLlmBody`), and a divergence guard against new inline MCP schemas.

  ### Guide

  - **In-app manual** (`ui/src/components/GuidePage.tsx`) — a "How it works" page from the user menu covering concepts, the governed loop, and the APIs.

  ### Fixes

  - Proper email validation with field-keyed errors on notification config; SMTP credentials verified before saving.
  - Dropped a misspelled Vercel automation bypass-cookie header.
  - Hierarchical folder tree keeps indenting past level 6.
  - Save on blur instead of every keystroke, with a Save/Saved state; per-node writes serialized so versions stay consistent.
  - `[[` autocomplete stays on-screen and instant; table controls stay inside the editor viewport; version-history content stays on-screen in a wider dialog.
  - Pinned LinearRouter for upstream routing parity.

## 1.9.0

### Minor Changes

- v1.9.0 — the workflow plane (typed edges, edge-type registry, governed runs, sub-agent runs), an email connector with per-nest digests, glossary definitions, markdown image uploads, and a unified document/folder sharing model.

  ### Workflow plane ("turing" track)

  - **Typed edges + edge-type registry** (`src/workflow/edge-routes.ts`, `src/workflow/edge-type-routes.ts`, `ui/src/components/EdgeTypesPage.tsx`) — a steward-articulated vocabulary of relations (`next`, `on-failure`, `derives-from`…). Flow edges (`is_flow`) participate in control flow and are DAG-validated; cycles are rejected with a 409 naming the path. Edge conditions run in three modes: `structured` (JSON predicate, a `term` resolves against the definitions glossary), `nl` (LLM-judged at execution, rationale logged), and `open`. Whole plane is off by default behind `FEATURE_WORKFLOW_PLANE`; every plane route 404s until enabled.
  - **Governed runs** (`src/workflow/run-routes.ts`, `src/workflow/run-service.ts`, `ui/src/components/RunsPage.tsx`) — the server never executes; external runners do. `POST /nests/:id/run/:agent` returns the complete executable bundle (agent node instructions, reachable flow-edge subgraph with conditions and referenced glossary definitions, and a `run_id`) in one round-trip. Steps are logged via `POST /runs/:id/steps` with server-assigned monotonic `seq`; terminal state is final (further steps/PATCH 409). Runs are replayable — recorded deterministic reads reproduce the identical read-set.
  - **Sub-agent runs** (`src/workflow/run-service.ts`, `test/subagent-runs.test.ts`) — a run can spawn nested runs via `parent_run_id`, gated separately behind `FEATURE_SUBAGENT_RUNS` because recursion is the risky surface. Bounded by `SUBAGENT_MAX_DEPTH` (height, clamped 1..32, default 8), `SUBAGENT_MAX_CHILDREN` (width, default 16), and `RUN_MAX_STEPS` (default 10000) so a runner can't fork-bomb the DB. Turning the plane off forces sub-agent runs off too.
  - **Workflow MCP tools** (`src/mcp/workflow-tools.ts`) — build + execute tools thread request origin into the plane so agents can drive edges and runs over MCP.

  ### Email connector + notification digests

  - **SMTP governance notifications** (`src/notify/email.ts`, `src/notify/email-render.ts`) — structured HTML notifications for review/approval/share events over `smtp://`/`smtps://` (nodemailer 9.0.3, exact pin). Requires `SMTP_URL` + `NOTIFY_EMAIL_FROM` + `NOTIFY_EMAIL_TO`; empty = off; also configurable in Settings.
  - **Per-nest digests** (`src/notify/notify.ts`) — events buffer per nest for `NOTIFY_DEBOUNCE_MS` (default 15000) so bursts (e.g. sharing a nest with a whole team) collapse into a single message instead of one per event.

  ### Glossary definitions

  - **Table-based ontology + real-time lookup** (`src/definitions/routes.ts`, `ui/src/components/DefinitionsPage.tsx`) — per-nest glossary of defined terms with a rename-collision guard and transaction-scoped reads; terms resolve inside structured edge conditions.

  ### Document authoring

  - **Images in markdown docs** (`src/nests/asset-routes.ts`, `ui/src/components/MarkdownEditor/MarkdownEditor.tsx`) — per-nest asset upload, serving, and editor insert.
  - **Ontology graph structure layer** (`ui/src/components/OntologyGraphView.tsx`, `src/nodes/graph-service.ts`) — nest + folder structure surfaced in the ontology view; slug-form wikilinks resolve into edges.
  - **Tabbed server settings** (`ui/src/components/SettingsPage.tsx`) — server settings reorganized into tabs with a single global save.

  ### Sharing & governance

  - **Unified document/folder sharing (grants model)** (`src/governance/grants-service.ts`, `src/nests/grant-routes.ts`) — one grants model for humans and agents; grants are honored under stewardship and on retrieval routes.

  ### Fixes

  - **Reject bare-root folder share targets** (`src/nests/grant-routes.ts`) — a bare-root folder target would have shared the whole nest.
  - **Imported document title derived from filename** (`src/governance/title-resolver.ts`, `test/import-nest.test.ts`).
  - **Edge traversal hardened** — node-id traversal guarded and the DAG check made atomic; edge flag gated per-route (not via `use("*")`) to unwedge the router; corrected seed call, cycle-path 409, and term-validation catch.
  - **Workflow-plane UI gated on the server feature flag for all users** (`ui/src/App.tsx`) so plane surfaces stay hidden until enabled.
  - **Shareable deep-link params for nest sub-pages** (`ui/src/App.tsx`); inline version diff in the governance diff viewer (`ui/src/components/governance/DiffViewer.tsx`).
  - **Notification hardening** — digest email line breaks preserved; empty `NOTIFY_DEBOUNCE_MS` guarded; admin-set SMTP timeout query param no longer duplicated; email envelope fields validated at the config boundary.

  ### Configuration & docs

  - New `FEATURE_WORKFLOW_PLANE`, `FEATURE_SUBAGENT_RUNS`, `SUBAGENT_MAX_DEPTH`, `SUBAGENT_MAX_CHILDREN`, `RUN_MAX_STEPS`, `SMTP_URL`, `NOTIFY_EMAIL_FROM`, `NOTIFY_EMAIL_TO`, and `NOTIFY_DEBOUNCE_MS` documented in `.env.example` and `CONFIGURATION.md`; `API.md` updated for the new endpoints; new `WORKFLOW_PLANE.md` documents the runner contract and guardrails.

## 1.8.0

### Minor Changes

- v1.8.0 — a server-level agent entry point, an activity trace, an external-sync primitive, scheduled agent/skill nodes, and a Slack connector.

  ### Agent entry point

  - **Connect once to the server instead of per nest** (`src/mcp/server-routes.ts`, `src/app.ts`) — a new server-level surface: `GET /llms.txt` (public agent manual covering endpoints, MCP, selector grammar, hop/skip retrieval, the `ctx` CLI and npm packages), `GET /index` (the caller's grounded nest index as markdown or json), and a stateless `ALL /mcp` endpoint exposing `nest_index` plus cross-nest read tools that take a `nest` id-or-name argument. Reads are gated per call via `resolveNestPermission` and nest-scoped API keys are honored; write tools stay on the per-nest `/nests/:id/mcp` endpoint so cross-nest mutation through one socket can't slip past authz.
  - **Agent docs page** (`ui/src/components/AgentDocsPage.tsx`, `ui/src/App.tsx`) surfaces the manual in-app.

  ### Superadmin activity trace

  - **One row per API request / MCP tool call** (`src/telemetry/trace-log.ts`, `ui/src/components/ActivityTracePage.tsx`) — an operator audit surface (who / what / where / outcome / duration) covering every API and MCP call in one place, with pagination. Writes are best-effort fire-and-forget with a rolling 14-day retention window pruned opportunistically. Distinct from product telemetry: it never leaves the server and ignores `TELEMETRY_ENABLED`. Postgres parity and MCP audit coverage added in review.

  ### External sync primitive

  - **`GET /nests/:id/changes?since=`** (`src/nodes/query-routes.ts`) — a change-feed endpoint for external mirrors that uses approval time as the change signal for public readers, so downstream copies only ever see approved content.

  ### Scheduled agent / skill nodes

  - **Agent and skill node types with a schedule** (`src/nodes/service.ts`, `src/nodes/routes.ts`, `ui/src/components/DocumentEditor.tsx`, `ui/src/components/NestView.tsx`) plus a `GET /runnables` orchestrator API that lists runnable nodes with their schedules. Schedule is string-coerced at the API boundary and surfaced in the UI.

  ### Slack connector

  - **Admin-configured incoming-webhook notifications** (`src/notify/slack.ts`, `ui/src/components/SettingsPage.tsx`) — optional team notifications for governance/review events (Settings → Slack webhook URL; empty = off). Deliberately minimal: a plain fetch with a short timeout, fire-and-forget so a Slack outage never slows or fails the triggering action. Notifications include the document title and folder; Slack mrkdwn control chars are escaped, the webhook input is masked, and a bad URL warns once then goes quiet. No new dependencies.

  ### Security & fixes

  - **Path-traversal guard on node ids** (`src/shared/node-id.ts`, `src/nodes/routes.ts`, `src/mcp/tools.ts`) — a centralized traversal guard applied across every node router, closing cross-tenant read/write/delete via crafted node ids.
  - **MCP nest-name resolution scoped to the caller** (`src/mcp/tools.ts`, `src/governance/title-resolver.ts`) — colliding nest names no longer resolve across tenants.
  - **Foldered node sub-routes served correctly** (`src/app.ts`) — `/hosted`, `/annotations`, and sibling sub-routes now resolve for documents in nested folders.
  - **Postgres schema/migration parity** (`src/db/migrations.ts`, `src/db/migrations.postgres.ts`) — `node_deletions` added to the Postgres schema with a migration-parity guard so the two backends stay in lockstep.

  ### Configuration

  - New `DB_*` / Slack-related settings documented in `.env.example` and `CONFIGURATION.md`; `API.md` updated for the new endpoints.

  ### Tests

  New/expanded coverage: `test/admin-trace.test.ts`, `test/agent-entrypoint.test.ts`, `test/changes-since.test.ts`, `test/migration-parity.test.ts`, `test/node-id-traversal.test.ts`, `test/runnables.test.ts`, `test/slack-connector.test.ts`, `test/wiki-node-filter.test.ts`, plus additions to `test/annotations.test.ts` and `test/db-postgres.test.ts`.

## 1.7.0

### Minor Changes

- e187c6d: v1.7.0 — anchored inline comments, delegated nest admins, nested folders, and a documented deterministic-retrieval API.

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
  - **Migration 012 — merge case-colliding user rows** (`src/db/migrations.ts`, `src/db/migrations.postgres.ts`) — pre-existing `Bob@x.com`/`bob@x.com` collisions (left behind by migration 009's NOCASE-unique constraint) resolved to different rows, so password resets and logins targeted the wrong account. The migration merges each case-insensitive email group into one winner and repoints every FK and email-keyed reference, then canonicalizes emails to lowercase. A follow-up fix corrected the steward dedup, whose correlated `EXISTS` self-matched every row in a collision group and deleted _all_ active steward grants for the email instead of collapsing duplicates — a governance regression hidden inside the login fix.

  ### Nest dashboard

  - **`GET /nests` tile metadata actually works** (`src/nests/routes.ts`) — was 500ing (`db.prepare` doesn't exist on the async DB adapter) and, once fixed, always reported 0 documents (missing `await` on `engineCache.get()`). Per-nest filesystem scans replaced with grouped queries over `node_versions`/`nest_collaborators`/`stewards`, so `Dashboard.tsx` nest tiles show accurate document/collaborator/steward counts with no per-load fs I/O.

  ### Tests

  New/expanded coverage: `test/annotations.test.ts`, `test/context-endpoint.test.ts`, `test/db-postgres.test.ts`, `test/delegated-admins.test.ts`, `test/invite.test.ts`, `test/key-mode.test.ts`, `test/mcp-routes.test.ts`, `test/merge-colliding-users.test.ts`, `test/nest-tile-metadata.test.ts`, `test/nested-folders.test.ts`.

## 1.6.0

### Minor Changes

- v1.6.0 — configurable nest storage and a PostgreSQL/Cloud SQL backend for durable Cloud Run deployments.

  ### Storage

  - **Configurable `NEST_STORAGE_ROOT`** — nest vault files (markdown + version history) can now live outside `DATA_ROOT`, e.g. on a GCS volume mount on Cloud Run, while the DB stays on `DATA_ROOT`. Path resolution is centralised so the root is set in one place (`src/config.ts`, `src/shared/paths.ts`, `src/nests/service.ts`). Defaults to `<DATA_ROOT>/nests`, so existing deployments are unchanged.

  ### Database

  - **PostgreSQL / Cloud SQL backend** — an async DB adapter lets the server run on PostgreSQL alongside the existing SQLite backend, with Cloud SQL Auth Proxy (unix socket) and TCP+TLS connection support for durable Cloud Run deployments (`src/db/adapter.ts`, `src/db/adapter.postgres.ts`, `src/db/adapter.sqlite.ts`, `src/db/migrations.postgres.ts`, `src/db/sql.ts`, `src/db/client.ts`). New `DB_*` env vars: `DB_DRIVER`, `DATABASE_URL`, `CLOUD_SQL_CONNECTION_NAME`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_POOL_MAX`, `DB_SSL`, `DB_SSL_CA`. SQLite stays the default when no connection is configured, so existing deployments keep working untouched (`CONFIGURATION.md`, `.env.example`).

  ### Fixes

  - **Security** — the admin guard on `/admin/settings` is now correctly awaited, closing a window where the async check did not gate the request (`src/app.ts`).
  - **AdminLoginModal** — now respects `PROMPTOWL_SIGN_IN_GATE` (`ui/src/components/AdminLoginModal.tsx`).
  - **Drift scanner toggle** — `DRIFT_SCAN_INTERVAL_MS=0` now disables the drift scanner (`src/index.ts`).
  - **Nest-root seam** — the unsynced-service no longer risks deleting live nests when `NEST_STORAGE_ROOT` is nested under `DATA_ROOT` (`src/nests/unsynced-service.ts`, `src/nests/service.ts`).

## 1.5.0

### Minor Changes

- v1.5.0 — AI-assisted context authoring, drag-and-drop ingestion, editor power tools, and a dedicated Server settings page.

  ### Authoring & AI

  - **"Add with AI"** — generate structured context from a prompt and push it straight into the nest; the assistant interviews and organizes the material rather than dumping raw text (`ui/src/components/GenerateContextModal.tsx`, `ui/src/components/NestView.tsx`, `ui/src/lib/api.ts`).
  - **Drag-and-drop file ingestion** — drop files directly onto a vault to import them, with a discoverable import button and an empty-state drop zone (`ui/src/components/NestView.tsx`).

  ### Document editor

  - **Raw markdown toggle** — switch the document editor between rich and raw markdown views (`ui/src/components/DocumentEditor.tsx`).
  - **Inline version diff** — view a highlighted diff against a prior version from inside the editor, with an unsaved-changes indicator and diff reset (`ui/src/components/DocumentEditor.tsx`, `ui/src/components/governance/VersionHistory.tsx`).
  - **HTML artifact markers** — documents containing HTML artifacts are flagged in both the document list and the recently-edited views (`ui/src/components/NestView.tsx`).

  ### Server settings

  - **Dedicated Server settings page** with admin controls for logo, telemetry, base URL, and upload size limit, backed by new `/admin/settings` GET/PATCH endpoints (`ui/src/components/SettingsPage.tsx`, `src/app.ts`, `ui/src/lib/api.ts`).
  - **Admin sign-in gate toggle** — admins can set the PromptOwl sign-in gate (`open` / `admin-only` / `disabled`) from the user menu (`ui/src/App.tsx`, `ui/src/lib/api.ts`).

  ### Fixes

  - `/admin/settings` PATCH is now atomic, with test coverage (`src/app.ts`, `test/admin-settings.test.ts`).
  - Whitespace-only passwords are rejected at registration/login (`src/auth/routes.ts`, `test/password-validation.test.ts`).
  - The document list reappears after clearing a no-result search in the Link-to-Document modal (`ui/src/components/DocumentPickerModal.tsx`).

## 1.4.0

### Minor Changes

- v1.4.0 — collaboration, hosted artifacts, ontology graph, and one-click SSO.

  ### Collaboration & sharing

  - **Standalone collaboration comments + activity log** — contributors can comment on documents independent of the review workflow, and a per-nest activity log records governance events (`src/governance/comment-service.ts`, `CommentsPanel.tsx`).
  - **Granular share permissions** — collaborator invites are now escalation-capped instead of admin-only, so an editor can invite another collaborator without exceeding their own permission tier (`src/nests/sharing-service.ts`).
  - **Shareable document URLs** — documents now have stable deep-link URLs that open the target document directly.

  ### Hosted artifacts & annotations

  - **Hosted artifacts + threaded annotations** — non-markdown artifacts can be hosted and viewed in-app, with threaded annotations anchored to artifact text (`src/annotations/*`, `ArtifactViewer.tsx`, `ui/src/lib/artifact-text.ts`).

  ### Ontology graph

  - **Ontology graph view** — an interactive canvas of nodes, `[[wikilinks]]`, and stewardship overlay that surfaces coverage gaps. Supports pan, zoom, and fit-to-view; steward emails are masked for the read tier and the drawn-node count is capped for large graphs (`src/nodes/graph-service.ts`, `OntologyGraphView.tsx`).

  ### Auth

  - **One-click SSO auto-login** — users can sign into ContextNest Community directly from PromptOwl via a short-lived SSO token (`src/auth/sso-token.ts`, `test/sso-route.test.ts`, `test/sso-token.test.ts`).

  ### Fixes

  - Hyperlink / wiki-link navigation now resolves to the configured target.
  - Comment and annotation projection conflict resolved.
  - Editors can add new collaborators in the UI.

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
