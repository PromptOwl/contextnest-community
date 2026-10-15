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
| `document-sidebar-dashboard-my-work` | Rail entry for My Work (carries the pending-count badge) — `ui/src/components/DocumentSidebar.tsx` |
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
| `nest-request-access` | Nest header: "Request edit access" for a viewer — `ui/src/components/NestView.tsx` |
| `request-access-pending` | Dialog shown when the caller's request is already pending |
| `request-access-denied` | Dialog shown inside the hour after a denial: who, why, when asking reopens |
| `request-access-loading` | Dialog while the caller's latest request is looked up |

## Metacognition agents (`ui/src/components/MetacognitionPanel.tsx`)

| Test ID | Element |
|---|---|
| `workflows-agents-tab` | Workflows → Agents tab (shown when `/health` says `metacognition_enabled`) — `ui/src/components/WorkflowsView.tsx` |
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
