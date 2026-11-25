---
"@promptowl/contextnest-community": minor
---

DM an agent: a person's message in a direct conversation with an agent now wakes that agent without an @mention, as a signed `agent.dm` webhook (same signature, Idempotency-Key, retries, delivery row and fences as `agent.mention`, with `read` = `context_conversation_read`). **Changed:** in a group conversation an agent used to be woken by, and list, every message; now only an explicit @mention reaches it (agents without a webhook included), and a message written by an agent never sends `agent.dm`. An agent woken in a conversation can file its approve card there (`context_propose`), and the decision wake reads the conversation back.
