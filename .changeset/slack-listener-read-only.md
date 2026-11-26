---
"@promptowl/contextnest-community": patch
---

Workflows → Agents shows a Slack channel's listener as "Managed by Slack", read-only, with its channel, folders and where to change it. Editing or deleting it from there, REST or MCP is refused (it would have stopped capture in that channel), and it is never picked as a channel watcher.
