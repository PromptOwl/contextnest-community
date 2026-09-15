---
"@promptowl/contextnest-community": minor
---

An agent can answer a comment, not just read one.

**Comment writes over MCP.** `context_comment` leaves a comment on a document — a new thread, or a reply into an existing one when given a thread id from `context_comments` — and `context_resolve_comment` marks a thread resolved or reopens it, recording who did it. They write to the same threads the web UI's comments panel shows, and carry the same side effects a comment left in the UI does: the person you `@`-mention is notified, and an artifact's derived `— Annotations` projection stays current. Commenting is read-tier, here as in the REST API, so a reviewer who can see a document can comment on it.

**Comments are readable from the cross-nest endpoint.** A client connected to the server-level MCP endpoint asking for a document's comments used to get `Tool context_comments not found` — for every node type. It's now declared there like the other read tools, nest-parameterised. (Writes stay on the per-nest endpoint.)

**A thread's replies keep their order.** Comment timestamps were stored to the second, with a random UUID as the tiebreaker, so two replies posted inside the same second came back in arbitrary order — in the thread and in the projection an agent reads. They're now stored to the millisecond. Existing comments are untouched and still sort correctly against new ones.
