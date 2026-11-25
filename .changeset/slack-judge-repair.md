---
"@promptowl/contextnest-community": minor
---

A Slack suggestion that breaks a fixable rule (wording copied from the chat, an owner or date not in the conversation, a title too long) is sent back to the model once instead of being dropped, so a good note isn't lost over how it was written. Nothing sensitive, from another document or against the people-folder rules is ever sent back, and the repaired answer passes the same checks. Adds a writing-style set for `npm run eval:surfaces`.
