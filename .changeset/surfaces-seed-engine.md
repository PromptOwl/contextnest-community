---
"@promptowl/contextnest-community": minor
---

**Surfaces seeds: give a new nest its shape in one click.** A seed is data, not code: folders, glossary definitions, a CONTEXT.md, an ontological thesis the listener reads, and the listener's settings (which folders it may propose into, domain tags, and categories it must never propose). Seeds ship bundled (`seeds/generic-team`) or live as approved nodes in a governed seed-library nest. Applying a seed is idempotent: it never duplicates, never overwrites a human edit, never re-creates something a person deleted, and can preview with `dry_run`. Admin-only folders such as `agents/` are enforced on every write, move, delete and approval path. DM private nests get the default seed, applied as their owner. The org mirror proposes people and team areas from the Slack workspace as review drafts, names only. REST `/surfaces/seeds/*` and MCP `context_surfaces_seed_*`.
