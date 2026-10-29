---
"@promptowl/contextnest-community": minor
---

Metacognition agents can notify people. An owner chooses, under "Who can it notify?", the nest owner, the reviewers and/or named members, how to reach them (email, the nest's own Slack/Teams connectors via the new `agent_notify` event) and a per-run cap (default 3, max 10). The agent picks only from those people, never an address of its own; each one is re-checked as a current member when it sends, the text is defanged with links limited to this nest's documents, every send is a run step and a message-log row, and the run's cost line shows how many notifications it sent. Off by default.
