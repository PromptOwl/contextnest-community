---
"@promptowl/contextnest-community": patch
---

**Approving a document no longer reads it back from storage after publishing.** To record the published version in its database, approval read the document file again right after the publish had written it — a round trip on Cloud Storage. The server's document cache already holds exactly what the publish wrote, so approval now takes it from there, and only reads the file if the cache has no copy.
