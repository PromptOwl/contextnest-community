---
"@promptowl/contextnest-community": minor
---

Team chat is on by default for a new installation. The first boot against an empty database stores it as on, the same as a superadmin turning it on in Settings, unless the deploy env sets `TEAM_CHAT_ENABLED` or `EXPERIMENTAL_AGENT_STREAM`. An existing server keeps its setting on upgrade.
