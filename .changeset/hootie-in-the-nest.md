---
"@promptowl/contextnest-community": minor
---

Hootie in the nest: a floating assistant on every page of the UI. It answers from what the person asking can read in the nest (the `/context` retrieval, run as the caller), streams the answer, cites the documents it used as chips that open them, follows the document you have open, and lets you `@tag` a colleague — which posts the exchange as a comment on that document and notifies them like any comment mention. `/` switches the nest. New `POST /nests/:id/chat` route (read tier, per-user rate limit), `HOOTIE_ENABLED` toggle in Settings → General (default on), answers with the server-wide Anthropic API key and says so when there isn't one. Model and model gateway URL (LiteLLM / PromptOwl) are superadmin settings too; the gateway URL also flows into agent runs, so one setting routes every model call.
