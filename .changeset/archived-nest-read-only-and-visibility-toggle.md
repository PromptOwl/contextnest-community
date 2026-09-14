---
"@promptowl/contextnest-community": patch
---

Fix a stuck organization-visibility toggle and close UI gaps around archived nests.

The header's quick visibility toggle could take a private nest to organization or public, but couldn't walk an organization nest back to private — it only offered escalation to public. It now routes an organization-visibility nest to the Collaborators tab, where all three tiers (private/organization/public) are available.

Archived nests are read-only everywhere writes are gated on `deriveNestCaps`/`resolveEditorAccess`, not just on the nest and document list: the Board's new-folder input and drag-to-move, the Definitions page's add/edit/delete term UI, and the document editor's Save/Submit/Discard/Revert and delete controls all now stay hidden on an archived nest regardless of how it was reached (dashboard, deep link, wiki link, or a page refresh). The Archived tab itself now sorts by archive date instead of creation date, and opening a nest from that tab correctly reflects an anon-owned nest for a caretaker admin.

Server-side enforcement (an archived nest 403s any non-GET) was already correct; this closes the remaining UI-side gaps so the affordances never appear in the first place.

Public Docs Reader Mode also rendered empty for any nest whose documents live under a subfolder (the common docs-site shape): the reader only ever showed the root level fetched on mount, with no way to expand into a subfolder. NestView now eagerly fetches the nest's first top-level folder alongside root when reader mode is on, and Reader Mode's folder rows fetch their own level on click, reusing the same lazy per-folder fetch the Documents tab already relies on.

Two further Reader Mode fixes: the home/overview pane no longer duplicates the center pane when the reader is already viewing the home document itself (it falls back to the Contents table instead), and the left folder list and Contents fallback now cap their height and scroll internally — matching the document viewer's existing behavior — so a long list no longer misaligns the three panes or forces the whole page to scroll.
