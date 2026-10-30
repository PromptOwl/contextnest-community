---
"@promptowl/contextnest-community": minor
---

**Saves return without waiting for the nest checkpoint or the index.** A create, edit, publish or delete now returns once the document and its version are on disk. The nest checkpoint and the index (`context.yaml`, `INDEX.md`) are updated right after, from a queue in the database. Writes that land together share one checkpoint, and anything left in the queue by a restart is finished at boot. Queries and selectors wait for queued writes, so they always see what was just saved.

The index and checkpoint are built from the document list the database already keeps, instead of reading every file in the nest. A move updates only the two folders it touches, and the server no longer rewrites the five agent config files (`CLAUDE.md`, `.cursorrules`, …) on every save. Requires engine 3.4.0.
