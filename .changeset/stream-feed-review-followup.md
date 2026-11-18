---
"@promptowl/contextnest-community": patch
---

Stream feed follow-up (po-1375). MCP tools that declare a string `enum` (`context_headless`, `context_set_visibility`, `context_nest_teams`, `context_systems`, `context_stream`) now have it enforced by the MCP layer since po-1214: an out-of-enum value is refused as invalid params before the tool runs, instead of reaching the tool's own error, and `tools/list` advertises the allowed values. On the server-level `/mcp`, `context_stream` and `context_versions` now follow REST's license rule for version history: unlicensed past the Free tier, suspended or offline-locked, they answer with the read-only message, as `GET /me/stream` and `GET …/versions` answer 503. `context_stream`'s input schema is generated from zod (same arguments). A change note a person writes that merely starts "Auto-published on " now shows on the stream; only the server's exact stamp is hidden.
