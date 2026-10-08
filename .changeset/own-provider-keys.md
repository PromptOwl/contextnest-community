---
"@promptowl/contextnest-community": minor
---

**Own provider keys (Enterprise, byok): the server keeps the licence's own-model key from PromptOwl.**

- PromptOwl's licence answer now carries the licence's own-provider LiteLLM key and its model list when byok is on. The server keeps it encrypted in the licence cache (migration 053) and drops it the moment byok or the licence lapses.
