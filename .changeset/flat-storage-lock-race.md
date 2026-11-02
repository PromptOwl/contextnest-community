---
"@promptowl/contextnest-community": patch
---

Imported-folder nests no longer briefly list as empty while a write is in progress. Document discovery now skips hidden folders (`.versions`, `.git`, …) instead of crawling them, so the engine's write lock folder appearing and disappearing under `.versions/` can no longer fail the listing with `ENOENT … .versions\.lock`.
