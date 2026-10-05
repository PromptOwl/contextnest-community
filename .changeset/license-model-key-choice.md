---
"@promptowl/contextnest-community": minor
---

**Models run on PromptOwl credits unless the licence allows your own key.** Hootie and workflow agent runs now take their model credential from one place. With the `byok` licence feature (Enterprise), they use a nest's own `ANTHROPIC_API_KEY` first, then the server's, as before. Without it, they use the PromptOwl model gateway that the licence check provides, metered in PromptOwl credits, and a stored own key is ignored (kept, not deleted). Saving an own key or gateway URL in Settings, or a model key in a nest's env, is refused without `byok` (`403`, Settings answers `code: "byok_required"`); clearing one is always allowed. Hootie's default model is now `claude-sonnet-5`, the efficient default the pricing spec calls for.
