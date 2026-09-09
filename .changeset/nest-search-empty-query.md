---
"@promptowl/contextnest-community": patch
---

**Search inside a nest waits for a query instead of listing the nest.** Opening the palette in a nest immediately listed every document in it, which read as a search that had already run — and the same overlay in a nest with nothing in it read "No matches" on an empty query. Both scopes now invite a term first, the way the all-nests scope always has.
