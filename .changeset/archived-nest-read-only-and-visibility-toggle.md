---
"@promptowl/contextnest-community": patch
---

Fix a stuck organization-visibility toggle and close UI gaps around archived nests.

The header's quick visibility toggle could take a private nest to organization or public, but couldn't walk an organization nest back to private — it only offered escalation to public. It now routes an organization-visibility nest to the Collaborators tab, where all three tiers (private/organization/public) are available.

Archived nests are read-only everywhere writes are gated on `deriveNestCaps`/`resolveEditorAccess`, not just on the nest and document list: the Board's new-folder input and drag-to-move, the Definitions page's add/edit/delete term UI, and the document editor's Save/Submit/Discard/Revert and delete controls all now stay hidden on an archived nest regardless of how it was reached (dashboard, deep link, wiki link, or a page refresh). The Archived tab itself now sorts by archive date instead of creation date, and opening a nest from that tab correctly reflects an anon-owned nest for a caretaker admin.

Server-side enforcement (an archived nest 403s any non-GET) was already correct; this closes the remaining UI-side gaps so the affordances never appear in the first place.
