---
"@promptowl/contextnest-community": minor
---

**Own provider keys (Enterprise, byok): the server keeps the licence's own-model key from PromptOwl.**

- PromptOwl's licence answer now carries the licence's own-provider LiteLLM key and its model list when byok is on. The server keeps it encrypted in the licence cache (migration 053) and drops it the moment byok or the licence lapses.
- **The Hootie model picks the key.** A model from the licence's own-provider list runs on the customer's own key; any other model keeps today's key (the server's Anthropic key with byok, else PromptOwl credits). The Hootie model picker lists the own-provider models alongside the rest (`own_models` on `GET /admin/models`). Agent runs are unchanged.
- **Settings → Hootie → Other model providers.** With byok, a server admin adds their own OpenAI, Google Gemini, xAI Grok or Groq key. Each key is checked with the provider on Save and kept by PromptOwl's model gateway (LiteLLM), never on this server; Settings shows only its last 4 characters (`own_providers` on `GET /admin/settings`, set via `provider_keys` on `PATCH /admin/settings`). The Hootie model picker labels those models "(your key)".
- **The Anthropic key card says what happens without a key.** With byok and no key set, it now says Hootie and runs use PromptOwl's virtual key on your plan's credits, instead of saying runs can't execute (`model_source` on `GET /admin/settings`).
