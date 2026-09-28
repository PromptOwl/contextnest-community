---
"@promptowl/contextnest-community": patch
---

Make deleting a folder clear, including empty ones. An empty folder now
shows its delete action without a hover, the confirmation and toast no longer
talk about deleting "0 documents", and an editor's deletion request on an
empty folder is accepted instead of failing with "Folder not found".
