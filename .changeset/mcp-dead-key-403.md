---
"@promptowl/contextnest-community": patch
---

A rotated or revoked API key on an MCP endpoint now fails with a clear "invalid or revoked" error instead of opening a sign-in screen that couldn't fix it. `/mcp` and `/nests/:id/mcp` answer a dead `cnst_` key with 403 `invalid_key`; REST routes still answer 401.
