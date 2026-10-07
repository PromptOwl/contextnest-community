---
"@promptowl/contextnest-community": minor
---

**Metacognition agents: agents the nest runs itself, that only ever propose.** With `FEATURE_METACOGNITION=true` (and the workflow plane on), an owner or admin can turn an agent document into a metacognition agent from Workflows → Agents. It runs on the nest's model key under its own persona name, on a schedule or on demand: it reads the folders you give it, checks the feeds and MCP tools you allow, looks back at how its earlier proposals were judged, and files fixes and new documents as drafts for a reviewer. It never publishes. Every step, the tokens it used, an estimated cost and who pays (PromptOwl credits, or your own key) are on the run's trace. Off by default.
