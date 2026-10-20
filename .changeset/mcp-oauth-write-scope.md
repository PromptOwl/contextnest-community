---
"@promptowl/contextnest-community": patch
---

MCP OAuth: the `/mcp` sign-in challenge now asks for `nests:read nests:write offline_access`. Clients request the scopes it names, so a connected agent could previously only read (writes were refused for scope with no way to step up) and was signed out when its one-hour token expired. One consent now covers reading, writing and a refresh token. Existing read-only grants get write by reconnecting once.
