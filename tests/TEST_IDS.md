# Test IDs Reference

All interactive UI elements used by Playwright tests carry `data-testid` attributes. Naming convention: kebab-case, hierarchical — `{area}-{component}-{element}` (e.g. `login-email-input`).

Add a row here whenever you add a `data-testid` to the UI.

## Login (`ui/src/components/Login.tsx`)

| Test ID | Element |
|---|---|
| `login-email-input` | Email text input |
| `login-password-input` | Password input |
| `login-submit-button` | Login / Create Account submit button |
| `login-name-input` | Name input (register mode) |
| `login-register-toggle` | Register / Login mode toggle link |
| `login-promptowl-button` | "Login with PromptOwl" device-auth button |
| `login-error` | Login error message |

## App Shell (`ui/src/App.tsx`)

| Test ID | Element |
|---|---|
| `header-breadcrumb` | Header breadcrumb nav |
| `global-search-trigger` | Global search button |
| `nest-sidebar-expand` | Sidebar expand control |
| `user-menu-trigger` | User menu button (post-login landmark) |
| `user-menu-account` | User menu → Account item |
| `user-menu-logout` | User menu → Logout item |
| `user-menu-settings` | User menu → Settings (opens Workspace settings) |
| `user-menu-help` | User menu → Help (How it works) |
| `header-ribbon` | Header "Workspace" ribbon — `ui/src/components/HeaderRibbon.tsx` (md and up) |
| `header-ribbon-my-work` / `header-ribbon-my-drafts` | Ribbon items; carry the count pill and `aria-current` |
| `document-sidebar-all-nests` | Rail: All nests (Home) — `ui/src/components/DocumentSidebar.tsx` |
| `document-sidebar-dashboard-<id>` | Rail "work" rows: Stream, Control room; My Work / My Drafts only below md (phone drawer) |
| `settings-nav` / `settings-nav-<id>` | Workspace settings left nav and its items — `ui/src/components/SettingsShell.tsx` |

## Nest page — Settings tab (`ui/src/components/NestView.tsx`)

Since #582 the nest's own settings and actions live on its Settings tab (the header's ⋯ menu is gone).

| Test ID | Element |
|---|---|
| `nest-settings-tab` | The nest's Settings tab trigger (not for grant-only readers) |
| `nest-settings-governance` | Review and access → "Edit review settings" (opens Nest settings; owner/nest admin, not on an archived nest) |
| `nest-settings-reader` | Review and access → "Reader mode: On / Off" (opens the Public Docs Reader Mode dialog) |
| `nest-settings-delete` | Danger zone → "Delete nest" (owner) or "Request deletion" (editor/admin) |
| `nest-stat-review` | Documents tab → "Your Review Queue" card: pending documents this person may decide |

## Nests Dashboard (`ui/src/pages/app/nests/page.tsx`)

| Test ID | Element |
|---|---|
| `nest-filter-input` | Nest name filter input |
| `nest-scope-select` | Scope select (My nests / shared / …) |
| `nest-sort-select` | Sort select |
| `nest-clear-filters` | Clear filters button |
| `nest-archived-switch` | Show archived toggle |
| `archived-nests` | Archived nests section |
| `archived-filter-input` | Archived section filter input |
| `archived-sort-select` | Archived section sort select |
| `archived-clear-filter` | Archived section clear filter |
| `restore-nest` | Restore archived nest button |
| `nest-browse-discovered` | Browse discovered nests link |
| `pin-nest` | Pin nest button |
| `nest-show-more` | Show more nests button |

## My Work (`ui/src/pages/app/my-work/page.tsx`)

| Test ID | Element |
|---|---|
| `header-ribbon-my-work` | Header ribbon entry for My Work (carries the pending-count badge) — `ui/src/components/HeaderRibbon.tsx` |
| `my-work-filter-chips` | The filter row: nest filter and chips |
| `my-work-nest-filter` | Filter by nest (only when the inbox spans two nests or more) |
| `my-work-chip-<key>` | Chips: `all`, `reviews`, `tasks`, `notifications`, `requests`, `waiting`; each but All carries its count |
| `my-work-mention` | One @mention row in the Mentions block — `ui/src/components/my-work/MentionRows.tsx` |
| `my-work-review-pane` | Column holding the review pane a review row opens — `ui/src/components/MyWorkReviewPane.tsx` |
| `review-pane` | The review pane itself — `ui/src/components/governance/ReviewPane.tsx` |
| `review-pane-note` | The author's note on the change |
| `review-pane-tab-<key>` | Pane tabs: `changes`, `preview` (Full draft), `published` (Live version) |
| `review-pane-actions` | Decision bar (also shows decision errors) |
| `review-pane-readonly` | Why the pane is read-only (own submission, outside steward scope) |
| `review-pane-approve` | Approve & publish (Post comment & approve with a comment open) |
| `review-pane-request-changes` | Request changes, then Send back to author |
| `review-pane-reject` | Reject, then Reject with reason |
| `review-pane-note-input` | Comment / reason textarea |
| `work-select-all` | Batch bar: select every review checkbox |
| `work-bulk-approve` | Batch bar: Approve N |
| `work-bulk-reject` | Batch bar: Reject N |
| `reason-dialog-input` | ReasonDialog reason textarea — `ui/src/components/governance/ReasonDialog.tsx` |
| `reason-dialog-confirm` | ReasonDialog confirm button |
| `reason-dialog-prior-decline` | ReasonDialog: the earlier "no" (who, when, note) above the input |
| `my-work-access-approve` | Access-request row: Approve (grants the access) |
| `my-work-access-deny` | Access-request row: Deny (opens the note dialog) |

## Request access (`ui/src/components/RequestAccessDialog.tsx`)

| Test ID | Element |
|---|---|
| `document-editor-request-access` | Document top bar: "Request edit access" for a viewer — `ui/src/components/DocumentEditor.tsx` |
| `document-editor-share-link` | Document ⋮ menu: "Share public link" — copies the document's public link, or publishes first (`ui/src/lib/share-link.ts`) |
| `publish-link-invite-<publishId>` | Publish dialog → Links: switch for the "Make your own nest" strip on that link — `ui/src/components/PublishDialog.tsx` |
| `doc-share-link-<nodeId>` | Documents list row ⋯ menu: "Share public link" — `ui/src/components/nest/DocumentsTab.tsx` |
| `nest-request-access` | Nest header: "Request edit access" for a viewer — `ui/src/components/NestView.tsx` |
| `request-access-pending` | Dialog shown when the caller's request is already pending |
| `request-access-denied` | Dialog shown inside the hour after a denial: who, why, when asking reopens |
| `request-access-loading` | Dialog while the caller's latest request is looked up |

## Metacognition agents (`ui/src/components/MetacognitionPanel.tsx`)

| Test ID | Element |
|---|---|
| `workflows-agents-tab` | Workflows → Agents tab (shown when `/health` says `metacognition_enabled` and the caller owns or administers the nest) — `ui/src/components/WorkflowsView.tsx` |
| `metacognition-panel` | The Agents panel |
| `metacognition-agent-row` | One configured agent: persona, scope, last run |
| `metacognition-run-now` | Run now button on a row |
| `metacognition-run-cost` | Last run's proposals · tokens · est. cost · who pays |
| `metacognition-run-summary` | Last run's closing summary |
| `metacognition-add` | Make an agent document a metacognition agent |
| `metacognition-form` | The configure form |
| `metacognition-name` | Persona name input |
| `metacognition-read` | Read folders input |
| `metacognition-propose` | Propose folders input |
| `metacognition-save` | Save button |
| `run-trace-metacognition` | Persona, cost and summary atop a run's trace — `WorkflowsView.tsx` |

Many more test IDs already exist across `ui/src/` (governance dialogs, document editor, nest tabs, …) — grep for `data-testid` and document them here as page objects start using them.

## Annotations (`ui/src/components/ArtifactViewer.tsx`, `HighlightedTextarea.tsx`)

| Test ID | Element |
|---|---|
| `artifact-preview-frame` | Hosted artifact preview iframe (mounted once, hidden outside Preview) |
| `raw-markdown-highlights` | Mirror layer under the raw markdown textarea; commented spans are `mark[data-thread-id]` |

## Graph — context pull replay (`ui/src/components/OntologyGraphView.tsx`, `PullLog.tsx`)

| Test ID | Element |
|---|---|
| `graph-pull-list` | The Pulls tab's list of context pulls |
| `graph-pull-item` | One pull in the list (click → replay) |
| `graph-pull-trace` | The selected pull's compiled context panel |
| `graph-pull-step` | One step of the compiled context; `data-lit="true"` once replayed |
| `graph-pull-replay-button` | Replay the selected pull |
| `graph-pull-hud` | Step readout over the canvas during a replay |
| `graph-pull-edges` | The edges the replayed pull walked |
| `graph-node` | A document node on the canvas (`data-node-id`, `data-pulled="true"` when lit) |

## New document and editor actions (`ui/src/components/TopBarTools.tsx`, `NestView.tsx`, `DocumentEditor.tsx`)

| Test ID | Element |
|---|---|
| `top-bar-new-document` | Top bar → New document; opens the "New document" dialog on the open nest (hidden where the nest is read-only) |
| `new-document-blank` | "New document" dialog → Blank document (opens the editor); Files / Upload PDF / Whole vault sit under it |
| `nest-upload-pdf` | "New document" dialog → Upload PDF |
| `document-editor-actions-top` | The editor's edit actions (Publish / Save draft / Submit for review) portalled into the top bar, md and up |
| `document-editor-actions-bottom` | The same actions in a sticky bar at the foot of the editor, below md |
| `document-editor-save` | The save button (reads Publish or Save draft) |
| `document-editor-submit` | Submit for review (document bar in view mode, edit actions in edit mode) |
