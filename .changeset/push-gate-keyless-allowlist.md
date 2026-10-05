---
"@promptowl/contextnest-community": patch
---

Fix "Always allow" doing nothing for pushes from PromptOwl. PromptOwl writes to a nest over MCP with a signed service ticket rather than an API key, so the held push carried no key to whitelist and every later push was held again. Confirming such a push with "Always allow" now whitelists that user's keyless agent writes (PromptOwl and signed-in MCP) on that nest, shown in the nest settings as "PromptOwl / signed-in session". The user's API keys are not affected and still need their own approval.
