# Test IDs Reference

All interactive UI elements used by Playwright tests carry `data-testid`
attributes. Naming convention: kebab-case, hierarchical —
`{area}-{component}-{element}` (e.g. `login-email-input`).

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

Many more test IDs already exist across `ui/src/` (governance dialogs,
document editor, nest tabs, …) — grep for `data-testid` and document them
here as page objects start using them.
