---
"@promptowl/contextnest-community": patch
---

Fix a startup crash on SQLite ("This database connection is busy executing a query") when upgrading a database that already has runs with traces: the run-totals migration (090) no longer writes while a read cursor is open.
