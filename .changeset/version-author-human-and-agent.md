---
"@promptowl/contextnest-community": patch
---

Every place that shows who wrote a version now names both the human and the agent. The Compare dropdown reads `misha via mkt-amplifier · 2h ago`. Version History shows `Agent: mkt-amplifier` under `By:`, with the session and custom keys in the hover title. The document page shows `Last edited by <name> via <agent>` under "Created by". The node detail (`GET /nests/:nestId/nodes/:nodeId`) adds `last_edit` with the latest version's `edited_by`, `edited_at` and `client`. MCP `context_get` adds a `**Last edited by:**` line for the version it serves. A version with no agent reads as before.
