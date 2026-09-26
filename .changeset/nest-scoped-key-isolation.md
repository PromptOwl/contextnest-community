---
"@promptowl/contextnest-community": minor
---

Nest-scoped API keys are now isolated to their nest. A key minted with `nest_id` could previously mint itself an unscoped whole-account key (`POST /auth/keys`), rotate itself to user-level, delete other nests, search and list every nest, and — owned by an admin — reach `/admin/*` and teammate management. A new app-wide guard makes a nest key deny-by-default outside its nest: it reaches its own nest, `/mcp` and `/index` (filtered), and `GET /nests` / `/search` / `/stats` narrowed to its nest; everything else answers `403` with `code: "nest_scoped_key"`. Minting or rotating a key onto a nest now requires access to that nest (`404` otherwise), and key responses report `nest_id`. In the app, the API keys page shows each key's scope ("All your nests" / "Nest: <name>") and has a scope picker, and a nest's Connect dialog can mint a key for that nest only, shown with the nest's MCP URL. Sessions and user-level keys are unchanged.
