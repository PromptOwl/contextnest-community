---
"@promptowl/contextnest-community": minor
---

Community usability + editor pass.

Admin & auth (in-platform — no email server):

- **Admin password reset** (`POST /auth/admin/reset-password/:userId`): set a user's password or generate a temporary one returned once for the admin to share; revokes the user's API keys + sessions. A self-service **Change password** action was added to the user menu so the recipient can set their own.
- **Remove users** (`DELETE /auth/users/:userId`): revokes api keys, sessions, steward + collaborator rows, then deletes the account. Blocks self-delete and users who still own nests.
- **`PROMPTOWL_SIGN_IN_GATE`** (`open` / `admin-only` / `disabled`): restrict "Sign in with PromptOwl" to the admin; everyone else uses email/password. Enforced server-side; the admin reaches it via `?admin=1`.

Agents & governance:

- **Plain-text view for agents** — `?format=markdown` on a node returns frontmatter + body as `text/markdown`.
- **Steward version revert** (`POST .../revert`) restores an earlier version as a new one; a pending-review document is now editable (saving withdraws the review, matching server behavior).

Editor: always-editable surface, selection bubble toolbar, turn-into, in-doc find & replace, wiki/code-safety fixes, and rich blocks (tables, callouts, toggles, syntax-highlighted code, columns).
