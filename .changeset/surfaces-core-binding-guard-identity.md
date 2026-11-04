---
"@promptowl/contextnest-community": minor
---

**Surfaces core: conversation bindings with a two-way privacy guard, and identity links.** The groundwork for capturing knowledge from Slack, Teams and email into a nest, with a person confirming each write. A conversation can be bound to a nest only when every reader of that nest is in the conversation (`capture_ok`). Nest content is shown back only when everyone in the conversation can read the nest (`surface_ok`). Server administrators are disclosed, not counted. Bindings pause automatically when membership or sharing changes, and a member can remove Nest from any conversation except general channels. Surface users link to Community users explicitly, by verified and confirmed email, or through a one-time sign-in link. New REST routes under `/surfaces/*`, a `/link/:token` page and 13 `context_surfaces_*` MCP tools. Off unless Surfaces is enabled; no surface adapters ship in this release.
