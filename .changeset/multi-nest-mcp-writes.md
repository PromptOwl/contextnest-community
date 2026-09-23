---
"@promptowl/contextnest-community": minor
---

MCP writes behave the same on every nest, and match the engine catalog.

- **`context_update` tags now replace the set** (the catalog's contract) instead of merging. Merging left no way to remove a tag over MCP. To add one, send the current tags plus the new one.
- **Frontmatter pasted into `content` is refused** on `context_create` / `context_update`, with a message saying to pass tags/status as parameters. It used to be stored as a second, dead frontmatter block in the body.
- **`context_move` returns `{ id, previous_id, title }` as structured data**, so `ctx move --vault <alias>` can read the result.
- **`/llms.txt` no longer tells `ctx` users to register the server-level `/mcp`** as a vault: `ctx` sends no `nest` argument, so every write through it failed. Register one alias per nest (`/nests/<id>/mcp`).
- **`nest_index` returns the nests as structured data** (`{ nests: [{ id, name, description, visibility, permission, document_count }] }`) alongside the markdown, so `ctx vault fix` can register one alias per nest.
