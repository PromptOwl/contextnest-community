---
"@promptowl/contextnest-community": minor
---

MCP writes behave the same on every nest, and match the engine catalog.

- **`context_update` tags now replace the set** (the catalog's contract) instead of merging. Merging left no way to remove a tag over MCP. To add one, send the current tags plus the new one.
- **Frontmatter pasted into `content` is refused** on `context_create` / `context_update`, with a message saying to pass tags/status as parameters. It used to be stored as a second, dead frontmatter block in the body.
- **`context_move` returns `{ id, previous_id, title }` as structured data**, so `ctx move --vault <alias>` can read the result.
- **One `/mcp` connection works for `ctx` across every nest.** The server-level tools now use the per-nest tool schemas plus a `nest` argument (the hand-kept copies had drifted, and undeclared keys were silently dropped). Reads that omit `nest` (`context_search`, `context_list`, `context_query`) return merged structured results, each hit tagged `nest: { id, name }`. Hits are interleaved round-robin across nests (search has no cross-nest relevance score), so a `limit` never fills up from the first nests alone. `context_overview` stays prose-only. `context_versions` is now served there too.
- **`nest_index` returns the nests as structured data** alongside the markdown, which `ctx vault list` uses to list each nest as `<alias>/<nest>`.
- **`/llms.txt`** documents registering the server once and addressing a nest as `--vault <alias>/<nest>`.
