---
"@promptowl/contextnest-community": patch
---

The @mention menus and the assignee picker list the nest's own people only, never every account on the server, even with Settings → Features → People directory on. `GET /nests/:id/mentionable` and the `people` list on `GET /nests/:id/collaborators` no longer add directory accounts, so a nest member can't browse unrelated users' names and email addresses. With the setting on, typing an `@` with someone's exact email (or unique name) still invites them, as before.
