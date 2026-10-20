---
"@promptowl/contextnest-community": patch
---

**Folder imports log where their time goes.** Each import call (every uploaded chunk, and the final registration) now logs one `[import] io` line listing how many times each storage operation and database index hook ran and how long they took, slowest first. On a network-backed `DATA_ROOT` this shows which operation dominates a slow import. Logging only; import behavior is unchanged.
