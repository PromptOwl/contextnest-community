---
"@promptowl/contextnest-community": patch
---

Internal: the per-nest and server-level MCP endpoints build tool schemas from one shared `toolShape` helper instead of two copies of the same loop. Advertised tool schemas are unchanged.
