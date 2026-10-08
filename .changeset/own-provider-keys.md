---
"@promptowl/contextnest-community": minor
---

**Own model keys (Enterprise, byok) for Anthropic, OpenAI, Google Gemini, xAI Grok and Groq, kept in PromptOwl's model gateway.**

- **Settings → Hootie → Model keys.** With byok, a server admin adds their own key per provider. Each key is checked with the provider on Save and kept by PromptOwl's model gateway (LiteLLM), never on this server; Settings shows only its last 4 characters (`own_providers` on `GET /admin/settings`, set via `provider_keys` on `PATCH /admin/settings`). With no own key, the card says Hootie and runs use PromptOwl's virtual key on your plan's credits. The License tab shows whether own model keys are on (`byok` on `GET /admin/license`).
- **The Hootie model's provider picks the key.** Any model from a provider with an own key (for example any OpenAI model, `gpt-4o` included) runs on that key; other models use PromptOwl credits. The Hootie model picker is searchable and grouped by provider (`providers` on `GET /admin/models`); a provider with an own key is marked "· your key".
- **The server-wide Anthropic key and "Model gateway URL" settings are gone.** A key already stored on the server is handed over to the gateway as the Anthropic key on the first boot with byok, then cleared. `anthropic_api_key`, `anthropic_api_key_masked` and `anthropic_base_url` are no longer accepted or returned by `/admin/settings`. A nest's own key in its Tool environment still works for agent runs; without one, agent runs use PromptOwl credits.
- PromptOwl's licence answer carries the licence's own-provider key and model list when byok is on. The server keeps it encrypted in the licence cache (migration 053) and drops it once PromptOwl stops sending it.
- **Hootie logs one request and one response line per question** (model, which key by its last 4 characters, token usage, timing). `HOOTIE_DEBUG_LOG=true` also logs the full prompt and answer (nest content) and warns at startup; keep it off in production.
