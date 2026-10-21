---
"@promptowl/contextnest-community": patch
---

Hootie now defaults to an efficient model (`claude-sonnet-5`) when no model is picked, instead of whatever default the PromptOwl gateway sends, so PromptOwl credits go further. A model picked in Settings → Hootie, and your own keys or model gateway, work as before. This also fixes picking `claude-sonnet-5` explicitly, which used to fall back to the gateway's default.
