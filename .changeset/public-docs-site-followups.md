---
"@promptowl/contextnest-community": patch
---

Public docs site fixes:

- Verifying a custom domain or public URL no longer hangs on a slow DNS server. The lookup gives up after about 5 seconds and says it timed out, and the daily re-check does the same without un-verifying the domain.
