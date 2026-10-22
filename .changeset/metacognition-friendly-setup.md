---
"@promptowl/contextnest-community": minor
---

Metacognition: the setup form now asks plain questions — what should it look at, what may it change, how much can it do each run — with a live one-sentence summary, a folder picker, and Light / Standard / Thorough effort presets (exact limits, model, feeds and MCP servers under Advanced). A new setup is prefilled from the agent document's approved instructions, with a "from the agent document" hint and reason next to each prefilled field; "Re-suggest from document" fills it again on request. New read-only route `GET /nests/:id/metacognition/:node/suggest` (owner/admin) returns that suggestion and never saves. (CU-wdqcq05rkp) Workflows → Agents is now shown to nest owners and admins only. That is a UI change: the API's tiers for listing, stats and run are unchanged in this release.
