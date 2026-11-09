---
"@promptowl/contextnest-community": minor
---

Mentions in My Work (agent team stream, S2). `GET /me/work` gains a `mentions` section: the open comment threads, in channels and on documents, that @mention you and that you haven't answered yet (replied in after the mention, or resolved), across every nest you can read. It pages on its own (`mentions_limit`, `mentions_offset`, `mentions_pagination`) and counts once in the My Work badge. The matching "mentioned you" notification no longer counts a second time. My Work shows a Mentions list, and each row opens the thread, either in the channel timeline or on the document. New MCP tool `context_my_work` returns the same sections as `/me/work`; on a nest-scoped key it returns only that nest. Mentions are recorded when a person posts, in a new `comment_mentions` table (migration 085). An `@handle` that names no person is kept for the agent-identity work to claim.
