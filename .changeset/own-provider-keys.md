---
"@promptowl/contextnest-community": minor
---

**Own provider keys (Enterprise, byok): the server keeps the licence's own-model key from PromptOwl.**

- PromptOwl's licence answer now carries the licence's own-provider LiteLLM key and its model list when byok is on. The server keeps it encrypted in the licence cache (migration 053) and drops it the moment byok or the licence lapses.
- **The Hootie model's provider picks the key.** Any model from a provider the admin added their own key for (for example any OpenAI model, `gpt-4o` included) runs on the customer's own key; other models keep today's key (the server's Anthropic key with byok, else PromptOwl credits). The Hootie model picker is searchable and grouped by provider (`providers` on `GET /admin/models`); a provider with an own key is marked "· your key". Agent runs are unchanged.
- **Settings → Hootie → Model keys.** One card for the Anthropic key and the other providers. The License tab shows whether own model keys are on (`byok` on `GET /admin/license`).
- **Own provider keys.** With byok, a server admin adds their own OpenAI, Google Gemini, xAI Grok or Groq key. Each key is checked with the provider on Save and kept by PromptOwl's model gateway (LiteLLM), never on this server; Settings shows only its last 4 characters (`own_providers` on `GET /admin/settings`, set via `provider_keys` on `PATCH /admin/settings`). The Hootie model picker labels those models "(your key)".
- **The Anthropic key card says what happens without a key.** With byok and no key set, it now says Hootie and runs use PromptOwl's virtual key on your plan's credits, instead of saying runs can't execute (`model_source` on `GET /admin/settings`).
