---
"@promptowl/contextnest-community": patch
---

**Submitting a document for review reads its version history once.** Submitting seals the draft into the document's history. It already read that history to check whether the version was sealed, and the seal then read it again; it now reuses the first read.
