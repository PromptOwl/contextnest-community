---
"@promptowl/contextnest-community": patch
---

**Faster publishing and approval from engine 2.10.** Updates `@promptowl/contextnest-engine` to 2.10, which cuts repeated storage reads from every publish and approval: each document's version history is read once instead of several times, the vault is listed once per publish, past versions are rebuilt with their files read together, only the changed folder's index is rewritten, and directories are no longer re-created before every write. On Cloud Storage this removes many round trips from each approval. Search over MCP also now reports the total number of matches.
