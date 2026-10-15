---
"@promptowl/contextnest-community": patch
---

Update `@promptowl/contextnest-engine` to 3.1.0. An imported document with a fractional `version` (e.g. `1.1`) no longer fails the whole import on Postgres; the engine repairs it to a whole number and reports a warning. Large imports and whole-vault scans keep all their I/O slots busy, which helps most on network-mounted storage. No Community code changes were needed.
