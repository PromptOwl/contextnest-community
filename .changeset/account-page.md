---
"@promptowl/contextnest-community": minor
---

Account page. The account menu's single **Account** entry opens `/account`: your avatar initial, name (edit in place), email with the Admin badge, and password (opens the change dialog). It replaces the Change password menu item. Backed by `PATCH /auth/profile { name }` — trimmed, ≤ 80 characters, empty clears the name so the email shows.
