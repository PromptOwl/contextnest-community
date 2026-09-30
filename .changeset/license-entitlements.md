---
"@promptowl/contextnest-community": minor
---

Licence features: enterprise capabilities are now unlocked by named features from PromptOwl, not by the licence tier.

PromptOwl's licence console sets a licence's tier and can grant or revoke individual features on it; the licence check now returns the effective list as `features`, and this server gates on it (`hasEntitlement("<feature>")`). The first feature is `hootie_branding` (custom assistant name and branding): an Enterprise licence gets it by default, and PromptOwl can also grant it to another licence or revoke it from an Enterprise one. The list is cached with the rest of the licence (new `license_cache.features_json` column, migration `048_license_cache_features`), so an outage keeps the same features. A PromptOwl that sends no `features` falls back to the tier defaults, so existing Enterprise licences behave exactly as before. A suspended, invalid or expired licence unlocks nothing.
