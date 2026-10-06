---
"@promptowl/contextnest-community": patch
---

**Approving or rejecting a document returns sooner.** Verdict notifications now run after the document's write lock is released, so the author's next save and the next document in a bulk approval no longer wait on them, and the document title is looked up once per verdict instead of three times. In the nest view the reviewed document leaves the review queue as soon as the verdict lands, without waiting for the queue to reload.
