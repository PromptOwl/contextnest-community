---
"@promptowl/contextnest-community": minor
---

Always-include documents. Tag a document `always-include`, or switch on **Always include** in its editor (owner or admin), and its approved text goes to every agent and model that works in the nest, along with the nest's CONTEXT.md. It is sent in the MCP connect message (`initialize.instructions`) on both the per-nest and server-wide endpoints. It is also added to `context_init`, Hootie's system prompt, metacognition agents and workflow run bundles. Drafts are never sent. Each caller gets only the documents they can read, and the text is capped at 24,000 characters; documents past the cap are listed by title and id. Always-include documents are prime, so in a governed nest the rules can't change without a steward's approval. The tag set is the new nest setting `always_include_tags` (migration 073), and the instructions page shows how many documents are always included. Outside clients receive these rules but may not obey them.
