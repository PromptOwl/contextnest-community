---
"@promptowl/contextnest-community": minor
---

Share a single document or folder from the UI — the human half of the grants model.

Grants (share one document, or everything under one folder, with one person)
already existed on the server and in MCP as `context_grant`, but the only way to
use them was an API call. Sharing something narrower than a whole nest meant
either handing over nest-wide collaborator access or writing a request by hand —
the wrong thing was the easy thing.

Added:

- **Share this document** on a saved document's ⋯ menu, and a share icon on
  every folder row in the nest view. Both open one dialog: add someone by
  email, see who the target is already shared with, and revoke. Owner/admin
  only, matching the `/nests/:id/grants` routes. Sharing from the UI is
  **view-only** and has no role picker — the API and `context_grant` still
  accept `write`, and a grant made that way is labelled as editable in the
  roster, but nobody hands out edit rights by leaving a dropdown where it was.
- **The recipient can now find it.** A grantee holds no nest-wide permission,
  so the nest was absent from their dashboard — being shared a document only
  worked if someone also sent the direct link. The nest is now listed for them
  as a viewer (`permission: "read"`, `roles: ["viewer"]`, `grant_only: true`),
  with the card scoped to their slice: `document_count` counts only the
  documents their grants cover, and the collaborator/steward roster comes back
  empty, so a one-document share never reveals the nest's size or its people.
  Grant-only nests stay out of the work inbox and `/stats` — those are
  governance surfaces over documents the grantee cannot read.
- **Fixed: "Nest not found" when opening a shared nest.** Following the link
  failed even with a valid grant — the middleware admitted the caller, then
  `GET /nests/:id` rejected them for holding no nest-wide permission, and the
  nest page's review-queue read surfaced the same 404 as an error toast. The
  grant check now lives in the one permission helper every nest route shares,
  so the nest resolves once for all of them instead of being patched per
  handler, and the page skips the governance reads a grantee was never allowed
  to make (seven wasted 404 round-trips per load). Authority is unchanged:
  rename, delete, import and settings-write still demand `owner`/`admin`, the
  governance paths still refuse a grantee, and `resolveNestPermission` — what
  the per-node grant checks key off — still answers `none`.
- `/llms.txt` now names `context_grant` and its arguments, so an agent reading
  the public manual can find the one-call path instead of inferring it.
- `API.md` documents `GET/POST/DELETE /nests/:nestId/grants` — resolution rules,
  the bare-`nodes`-root rejection, and how grants behave on move/delete/export.

Access is not stewardship: a grant lets someone reach exactly the granted
document (or folder subtree) and nothing else in the nest, and confers no
approval rights. Nothing was loosened — `resolveNestPermission` still returns
`none` for a grantee, and every read past the card runs through the same grant
checks as before.
