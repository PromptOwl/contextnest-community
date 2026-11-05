---
"@promptowl/contextnest-community": patch
---

MCP endpoints (`/mcp` and `/nests/:id/mcp`) now answer GET and DELETE with 405 instead of opening an SSE stream that closed at once. MCP clients stop reconnecting in a loop, which had pinned the server's CPU and made Cloud Run turn requests away with 429s.
