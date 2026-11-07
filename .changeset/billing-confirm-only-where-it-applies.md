---
"@promptowl/contextnest-community": patch
---

MCP tools now list `confirm_billing` only where it does something: `context_share_nest`, `context_grant`, `context_assign_steward` and `context_resolve_access_request`. Every other tool, including all of the server-level `/mcp`, no longer shows a billing parameter it never used. Confirming a raise works as before.
