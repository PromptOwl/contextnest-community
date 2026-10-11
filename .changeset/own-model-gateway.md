---
"@promptowl/contextnest-community": minor
---

Bring back the server's own model gateway (Enterprise, licence feature `byok`). Set `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`, or use Settings → Hootie → Model gateway, to route Hootie and agent runs through your own LiteLLM in front of Bedrock, Azure, Ollama or any provider. Calls and nest content then stay on your network. This was retired by mistake along with the server Anthropic key.

The URL and key are used as a pair, ahead of PromptOwl's gateway and own-provider keys. The key is checked against the gateway on save and is never returned. A key paired with a gateway URL is never handed to PromptOwl at boot, and clearing the URL clears its key.
