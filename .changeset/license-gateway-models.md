---
"@promptowl/contextnest-community": patch
---

**Hootie asks the PromptOwl gateway for a model it actually serves.** On the PromptOwl model gateway, models have PromptOwl's team names (e.g. `default-claude/claude-sonnet-5`), so asking for `claude-sonnet-5` failed with "no healthy deployments". Models are now picked and stored by plain name (`claude-sonnet-5`); on the PromptOwl gateway the server adds PromptOwl's instance prefix when it calls, so a name set through the API without it still works. With no model picked, Hootie uses the gateway's default; on your own key, `claude-sonnet-5`. Settings → Hootie → Model is a dropdown of every model this server's key can reach (new `GET /admin/models`, server admins only); if the list can't be loaded, a name can be typed. A model the gateway doesn't serve now reads "No model named … is available on this key" instead of a generic error.
