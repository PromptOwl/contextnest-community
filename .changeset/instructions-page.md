---
"@promptowl/contextnest-community": minor
---

Instructions: a new nest tab shows the nest's CONTEXT.md, the operating instructions every agent reads first through `context_init`. Owners and nest admins can edit it, and each change is recorded with who made it, when and why, whether it came from this page, `ctx push` or an agent over MCP. History shows what each revision changed, and any revision can be restored. A save made against an out-of-date copy is refused rather than overwriting someone else's change. MCP parity: `context_instructions_history` (read) and `context_instructions_update` (owner/admin, held for confirmation on nests that hold agent writes).
