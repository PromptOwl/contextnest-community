---
"@promptowl/contextnest-community": patch
---

**Folder import records its documents in a few queries instead of a few per document.** Finalizing an import used to write each document's version row, approval and tag index one document at a time, which on a hosted database is a round trip per statement. These are now multi-row writes for the whole batch. The on-disk status repair now runs only for documents whose publish actually failed, rather than reading every held draft back from storage; a held document that states its own status (such as `pending_review`) keeps it on disk instead of being flattened to `draft`. Each staged upload chunk now logs its duration (`[import] staged: … ms=`) next to the existing register timings, so a slow import shows which phase the time went to.
