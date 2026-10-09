---
"@promptowl/contextnest-community": minor
---

**The server now knows its pricing plan.** The license check reads the plan PromptOwl assigns to the key (Free, Trial, Self-Hosted or Enterprise) and its limits: billed users, Account Owners, and subscribers (editors). A missing field takes the plan's default, and a key with no plan, or no license at all, runs as Free (10 users, 1 Account Owner, no subscribers). The seat limits and model-key rules below are enforced from it.

**Model gateway key, cached encrypted.** When PromptOwl issues the license a LiteLLM key for running models on PromptOwl credits, the server keeps it encrypted in the license cache (new `license_cache.gateway_json` column, migration `049_license_cache_gateway`) and in memory. It is never part of any API response, and it is dropped as soon as the license stops being valid.
