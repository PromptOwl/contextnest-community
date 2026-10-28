---
"@promptowl/contextnest-community": minor
---

Metacognition agents over MCP, and metacognition is now owner/admin only.

- **MCP tools.** `context_metacognition_list`, `context_metacognition_suggest`, `context_metacognition_configure`, `context_metacognition_run` and `context_metacognition_remove` on `/nests/:id/mcp` and the server-level `/mcp` (with `nest`), so a harness like Claude can set an agent up from a conversation. `context_metacognition_configure` takes the REST PUT body plus `dry_run`; `context_metacognition_suggest` returns the same starting config as `GET …/suggest`, and `notify` passes through configure; a dry run validates and returns the normalized config and a plain-language summary ("Archivist will read gtm and ops, may suggest edits in gtm, up to 5 per run, … It never publishes; every change goes to a reviewer.") without saving. The tools call the same code as the REST routes, so gates, `parseConfig` messages, `409`s and start limits match. Advertised only while `FEATURE_WORKFLOW_PLANE` and `FEATURE_METACOGNITION` are on, and only to a person who owns or administers the nest; system, headless and read-only keys never see them.
- **Owner/admin only (breaking for writers).** Listing, viewing, stats and running a metacognition agent now need the nest owner or an admin, as configuring already did. That covers `GET /metacognition`, `GET /metacognition/:node`, `/stats`, `POST /metacognition/:node/run`, `POST /run/:node` on a metacognition agent, `workflow_runs_list { agent_stats: true }`, and creating a schedule or hook for one, or changing its schedule. A writer now gets `403`.

  **Upgrade note.** Schedules and inbound hooks that a writer created for a metacognition agent before this release keep firing: they start runs under their own authority, and only creating them or changing a schedule is gated now. An owner or admin who wants them gone can delete them under Workflows → Activity (schedules) or the hooks API.
- **`context_metacognition_list` shows approval state.** Each agent and agent document carries `instructions_approved`. A document with no approved version would be skipped at run time, so a harness can warn before setting one up.
