---
"@promptowl/contextnest-community": minor
---

Only server admins can create nests by default. New `NEST_CREATION` setting (`admins` default, or `everyone`) gates `POST /nests`, folder import and the MCP `nest_create` tool with a `403` for anyone else, and `GET /health` reports it as `nest_creation`. Non-admins no longer see New Nest, Import Folder or Create First Nest; with no nests they see "You don't have access to any nests yet. Ask [admin] to share one." Set `NEST_CREATION=everyone` to keep the old behaviour.
