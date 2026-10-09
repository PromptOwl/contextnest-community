---
"@promptowl/contextnest-community": patch
---

Postgres servers whose `runs` table predates run claiming no longer crash at boot with `column "claimed_by" does not exist`; the migrations now add the missing claim columns.
