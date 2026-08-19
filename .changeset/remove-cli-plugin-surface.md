---
"@promptowl/contextnest-community": patch
---

Remove the duplicated CLI/plugin surface — it now lives in the ContextNest repo.

The `ctx` CLI and the agent plugins are consolidating upstream in
[PromptOwl/ContextNest](https://github.com/PromptOwl/ContextNest) (`packages/cli`,
`plugins/`, `.claude-plugin/`). The community server carried its own copy of that
contract — install commands, a `ctx push` snippet, and a CLI section in the public
agent manual — which is exactly the drift the Engine & CLI Sync Discipline in
`CLAUDE.md` exists to prevent. Every published `ctx` invocation was a second place
the CLI's flags and command surface had to stay correct.

Removed:

- The **CLI** tab in the nest Connect dialog (the `ctx push --server … --nest …`
  snippet and the `npm i -g @promptowl/contextnest-cli` install line).
- The **CLI** client hint on the dashboard.
- The `CLI (ctx)` row in the Guide's surfaces table, which pointed at the
  now-removed Connect tab.
- The `## ctx CLI` section and the CLI package entry in the `/llms.txt` agent
  manual, plus the CLI scaffolding block in `README.md`.

No server behavior changes. MCP and the REST API — the community server's own
surface — are untouched, and remain the documented way for an agent to read and
write a nest remotely. Anyone wanting the CLI installs it from upstream, where
its documentation is now the single source of truth.
