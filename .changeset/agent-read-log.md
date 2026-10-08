---
"@promptowl/contextnest-community": minor
---

Agent read log: the activity log now answers "what did agent X read, and which version did it see".

- **Recorded where it wasn't.** An agent's MCP `context_search` — its most common read — was never recorded (the hits come back under `results`, which the recorder didn't look at). Now it is, along with `context_table_query`, REST `/table-query`, and historical version fetches (`GET …/nodes/:id/versions/:version`).
- **Which version.** Read and retrieval rows carry the version the caller was served. Under stewardship an agent is given the approved version, and that is what the row records; with the versioned history that rebuilds exactly what the agent saw. A new version is a new row (it's part of the throttle key).
- **Which agent.** REST reads now carry the agent the API key's label names (the same derivation writes already used), and Hootie's retrievals are attributed to `hootie`. `GET /nests/:id/activity-log?agent=<name>` filters to one agent; the Activity panel has an Agent filter.
- **On by default, owner-only off.** New nest setting `access_log_enabled` (default on). Any nest admin may turn it on; only the owner or server admin may turn it off. Shown in nest Settings.
- Recording stays fire-and-forget and never fails a read; the inserts are now one multi-row statement per call. Only ids and versions are stored — never content or what was searched.

Migration `050_agent_read_log`: `node_access_events.version` and `.agent` (indexed, backfilled from `client_json` on SQLite), `nests.access_log_enabled`.
