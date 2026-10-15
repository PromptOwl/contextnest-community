---
"@promptowl/contextnest-community": patch
---

**New `IMPORT_IO_CONCURRENCY` setting for large imports.** It sets how many file operations one folder import keeps in flight (publishing runs half as many documents at once). Unset keeps the engine default of 32. On a network-backed `DATA_ROOT` such as Cloud Storage via gcsfuse, where every file operation is a round trip, raising it (for example to `64`) shortens large imports; each in-flight file is held in memory, so peak memory grows with it.
