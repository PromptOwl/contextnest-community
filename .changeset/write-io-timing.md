---
"@promptowl/contextnest-community": patch
---

**Write timing in the server log.** Each document create, update, delete, move and approve logs one `[write] io <op>:` line with its total time and the steps it waited on: storage calls (with counts), the engine operation (vault lock and checkpoint included), the index sync and notifications. Slow saves on a network-mounted vault now show which step dominates.
