---
"@promptowl/contextnest-community": patch
---

Fix nest activity-feed totals on Postgres.

`COUNT(*)` comes back from Postgres as a bigint, which `pg` hands to the app as
a string, so the feed's totals concatenated instead of adding: a nest with 12
pending changes and 3 held writes reported 123 items. SQLite was unaffected
(it returns a number), so this only ever showed on a Postgres-backed server.

Each count is coerced with `Number()` before the arithmetic. The per-type
`counts` object was already correct — only the summed `total` was wrong.
