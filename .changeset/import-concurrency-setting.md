---
"@promptowl/contextnest-community": patch
---

**Import concurrency is editable from Server settings.** Settings → Basic → Import concurrency sets `IMPORT_IO_CONCURRENCY` (1–256, default 32) without a redeploy: the value is stored with the other server settings and applies to the next import. Raise it on network storage (Cloud Storage) to speed up large folder imports.
