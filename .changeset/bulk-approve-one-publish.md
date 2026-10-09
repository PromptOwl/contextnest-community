---
"@promptowl/contextnest-community": patch
---

**Bulk approval publishes the whole batch at once.** Approving several documents from the Review tab or My Work used to run a full publish for each one in turn — each sealing its own checkpoint and rebuilding the nest's index. The batch is now checked in a few queries, published in a single engine call (documents in parallel, one checkpoint, one index rebuild), and then recorded and notified per document exactly as a single approval is. A document that is not pending, not yours to approve, or that the engine refuses to publish is reported as failed and left pending, so it can be retried; previously a document whose publish failed could still be marked approved. The version-history note is the reviewer's note, or "Approved in bulk review" when none is given.
