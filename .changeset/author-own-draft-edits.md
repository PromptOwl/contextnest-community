---
"@promptowl/contextnest-community": patch
---

Authors can fix their own drafts from every surface, including while their draft is awaiting review.

- **Documents list and artifact viewer.** The person who submitted a document for review now gets Edit there too. Both screens used to lock everyone out, while the server and the document editor already let the submitter revise (the open review moves to the new version). Everyone else is still locked until the review resolves.
- **Read your draft back over MCP.** `context_my_drafts` takes an optional `id`/`title` and returns *your* unapproved working copy, so an agent fixing a draft can see what it is fixing. Only the author of the current draft (or whoever submitted its review) with edit rights gets it — owners and stewards are refused. `context_get`, search and query stay approved-only for everyone, the author included, so an agent running on the author's key keeps answering from approved text.
