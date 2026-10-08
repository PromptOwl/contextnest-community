---
"@promptowl/contextnest-community": patch
---

**Saving, publishing and approving no longer read each document back from storage.** After every document write, the server read the file back to refresh its document cache and search index — one extra round trip per save on Cloud Storage. It now uses the text it just wrote, which is exactly what the read would have returned, and a successful delete is recorded without a read. A write that fails part-way is still checked against storage as before.
