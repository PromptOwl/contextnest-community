---
"@promptowl/contextnest-community": minor
---

Agent principal: hiring a key agent now gives the agent its own identity in the nest (a no-login service user owned by the person who hired it, an editor of that nest only, holding the agent's nest-scoped key), and `config.url` adds its wake webhook in the same hire. Any member can DM or @mention a hired agent and the agent reads that conversation with its own key. The person who asked can approve the agent's approve card; an agent never approves or rejects a review, can't sign in, isn't a seat, and never resolves above editor or outside its nest. An agent reads the full text of its own memory while it is in review. New: `GET /nests/:id/hire/me` and MCP `context_agent_identity` (who am I, who owns me). Key agents hired before keep working and are marked `legacy`.
