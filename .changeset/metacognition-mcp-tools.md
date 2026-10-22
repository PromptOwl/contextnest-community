---
"@promptowl/contextnest-community": minor
---

Metacognition agents over MCP, and metacognition is now owner/admin only.

- **MCP tools.** `metacognition_list`, `metacognition_configure`, `metacognition_run` and `metacognition_remove` on `/nests/:id/mcp` and the server-level `/mcp` (with `nest`), so a harness like Claude can set an agent up from a conversation. `metacognition_configure` takes the REST PUT body plus `dry_run`; a dry run validates and returns the normalized config and a plain-language summary ("Archivist will read gtm and ops, may suggest edits in gtm, up to 5 per run, … It never publishes; every change goes to a reviewer.") without saving. The tools call the same code as the REST routes, so gates, `parseConfig` messages, `409`s and start limits match. Advertised only while `FEATURE_WORKFLOW_PLANE` and `FEATURE_METACOGNITION` are on, and only to a person who owns or administers the nest; system, headless and read-only keys never see them.
- **Owner/admin only (breaking for writers).** Listing, viewing, stats and running a metacognition agent now need the nest owner or an admin, as configuring already did. That covers `GET /metacognition`, `GET /metacognition/:node`, `/stats`, `POST /metacognition/:node/run`, `POST /run/:node` on a metacognition agent, `workflow_runs_list { agent_stats: true }`, and creating a schedule or hook for one, or changing its schedule. A writer now gets `403`.
