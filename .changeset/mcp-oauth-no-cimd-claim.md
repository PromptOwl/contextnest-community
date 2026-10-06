---
"@promptowl/contextnest-community": patch
---

MCP OAuth: stop advertising Client ID Metadata Document support until it is implemented, so Claude registers through `/oauth/register` (DCR) instead of failing on an unresolvable client_id.
