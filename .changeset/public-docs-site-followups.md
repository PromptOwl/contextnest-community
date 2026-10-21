---
"@promptowl/contextnest-community": patch
---

Public docs site fixes:

- Verifying a custom domain or public URL no longer hangs on a slow DNS server. The lookup gives up after about 5 seconds and says it timed out, and the daily re-check does the same without un-verifying the domain.
- Large docs sites use much less server memory. Each page now carries one copy of the page list instead of two (it still shows as a sidebar on desktop and a "Contents" dropdown on phones), and the server keeps at most about 256 MB of built sites in memory, dropping the least recently used first.
