---
"@promptowl/contextnest-community": minor
---

Agents woken in the team chat can put an approve card in front of their own work, and continue when a person decides. `context_propose` (MCP) and `POST /nests/:id/threads/:threadId/propose` file the agent's plan as a draft for review under its own key and post a card in the thread; approving or rejecting it (REST or MCP, as any review) sends the agent one signed `agent.proposal.decided` wake with the thread and the decision. An agent deciding its own card wakes nothing. `AGENT_WEBHOOK_INTERNAL_HOSTS` lets the operator name internal runner hosts (e.g. `runner` on the same compose network) that an agent webhook may target; every other private address is still refused.
