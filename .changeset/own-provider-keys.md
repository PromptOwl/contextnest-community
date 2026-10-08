---
"@promptowl/contextnest-community": minor
---

**Own provider keys (Enterprise, byok): the server keeps the licence's own-model key from PromptOwl.**

- PromptOwl's licence answer now carries the licence's own-provider LiteLLM key and its model list when byok is on. The server keeps it encrypted in the licence cache (migration 053) and drops it the moment byok or the licence lapses.
- **The Hootie model picks the key.** A model from the licence's own-provider list runs on the customer's own key; any other model keeps today's key (the server's Anthropic key with byok, else PromptOwl credits). The Hootie model picker lists the own-provider models alongside the rest (`own_models` on `GET /admin/models`). Agent runs are unchanged.
