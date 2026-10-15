---
"@promptowl/contextnest-community": minor
---

Agents can name the model their runner should use.

- **`model` on agent and skill nodes.** Set it on create or update (REST), the same way as `schedule`: runnable types only, `""` clears it, and converting away from a runnable type drops it. It's stored in frontmatter `metadata.model` and echoed on node responses and `GET /runnables`.
- **`agent.model` in the run bundle.** `POST /run/:agent`, `GET /runs/:id/bundle` and MCP `workflow_run` return it (`null` when unset), so a runner can put each agent on its own model instead of one global default.
