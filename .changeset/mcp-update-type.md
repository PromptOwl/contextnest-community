---
"@promptowl/contextnest-community": patch
---

`context_update` now accepts an optional `type` over MCP (per-nest and server-level `/mcp`), so a node can be re-typed in place without delete + recreate. It uses the same gate as REST `PATCH` and the UI's "Turn into": unknown types are refused with a readable error, and version history and review state are kept.
