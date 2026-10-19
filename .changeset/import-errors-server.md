---
"@promptowl/contextnest-community": patch
---

**Folder imports say what happened.** `POST /nests/import` responses now carry `problems` (each refused file, document kept as a draft, or document not imported, as a readable `path: reason` line) and `warnings` (repairs made on the way in, such as a whole-number version or a derived title), alongside the unchanged `documents` and `rejected`. One document whose records fail no longer fails the whole import: the rest are imported and that one is named. A step that fails outright reports "Import stopped while uploading files: …" or "… while publishing documents: …" instead of "Something went wrong"; a vault-lock timeout stays a retryable `503` and an engine validation refusal stays a `400`.
