---
"@promptowl/contextnest-community": patch
---

Fix a stuck organization-visibility toggle and close UI gaps around archived nests.

The header's quick visibility toggle could take a private nest to organization or public, but couldn't walk an organization nest back to private — it only offered escalation to public. It now routes an organization-visibility nest to the Collaborators tab, where all three tiers (private/organization/public) are available.

Archived nests are read-only everywhere writes are gated on `deriveNestCaps`/`resolveEditorAccess`, not just on the nest and document list: the Board's new-folder input and drag-to-move, the Definitions page's add/edit/delete term UI, and the document editor's Save/Submit/Discard/Revert and delete controls all now stay hidden on an archived nest regardless of how it was reached (dashboard, deep link, wiki link, or a page refresh). The Archived tab itself now sorts by archive date instead of creation date, and opening a nest from that tab correctly reflects an anon-owned nest for a caretaker admin.

Server-side enforcement (an archived nest 403s any non-GET) was already correct; this closes the remaining UI-side gaps so the affordances never appear in the first place.

Public Docs Reader Mode also rendered empty for any nest whose documents live under a subfolder (the common docs-site shape): the reader only ever showed the root level fetched on mount, with no way to expand into a subfolder. NestView now eagerly fetches the nest's first top-level folder alongside root when reader mode is on, and Reader Mode's folder rows fetch their own level on click, reusing the same lazy per-folder fetch the Documents tab already relies on.

Two further Reader Mode fixes: the home/overview pane no longer duplicates the center pane when the reader is already viewing the home document itself (it falls back to the Contents table instead), and the left folder list and Contents fallback now cap their height and scroll internally — matching the document viewer's existing behavior — so a long list no longer misaligns the three panes or forces the whole page to scroll.

Three more Reader Mode fixes: navigating to any document left no way back to the overview/home doc — the center pane now shows a "Back to Overview" link whenever the reader is away from the home node. A folder in the left pane, once opened, could never be collapsed back, permanently eating vertical space — folder rows are now a collapse/expand toggle (defaulting open) with a chevron indicator. And the left folder list, center document, and right overview/contents panes now all share the same min/max height so the three columns line up instead of drifting out of alignment.

Fixed one more Reader Mode issue: every known folder's chevron defaulted to the "expanded" (down) icon even when its documents hadn't been fetched yet, so unopened folders looked open but showed nothing underneath. A folder's row now only defaults to expanded once its docs are actually loaded (root and the eager first-level folder); every other known folder defaults collapsed until clicked, so the icon always matches what's on screen.

Public Docs Reader Mode could previously only be turned on by the server (super) admin — a nest's own owner had no way to enable it for their own nest without asking an operator. `PATCH /nests/:id/reader-mode` and the "Reader: On/Off" button now also accept the nest's owner or an admin collaborator, on top of the server admin (who keeps access on every nest, same as before). A write or read collaborator, and anonymous visitors, remain refused.
