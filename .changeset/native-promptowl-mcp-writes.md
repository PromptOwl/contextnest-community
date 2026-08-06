---
"@promptowl/contextnest-community": minor
---

Native PromptOwl connection: accept the short-lived `scope: "mcp"` service
ticket on the per-nest `/nests/:id/mcp` transport (in addition to `/index`,
server-level `/mcp`, `POST /context`, and `GET /nodes`), so a PromptOwl block
granted read & write on one nest can reach that nest's write tools. Add two
server-level bootstrap writes — `nest_create` and `context_create` — to the
cross-nest `/mcp`, each gated by the same per-user write checks, suspend
kill-switch, and license gate the per-nest path enforces. The MCP ticket and
the one-click SSO login ticket are now mutually exclusive: `/auth/sso` refuses
an `mcp`-scoped ticket and the MCP middleware refuses a ticket carrying a
`jti`.
