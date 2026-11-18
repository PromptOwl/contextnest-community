---
"@promptowl/contextnest-community": patch
---

The Control room is for superadmins only (po-1406). Since first-run onboarding every user owns a nest, so the 2026-11-09 rule that showed it to nest owners and admins showed it to everyone while Surfaces was on. Now only a signed-in superadmin (never `AUTH_MODE=open`) sees it in the rail; anyone else who opens `/control-room` lands on Nests. The REST reads that serve the page (`GET /ledger`, `/ledger/:entryId`, `/rollups`, `/nests/:id/ledger`, `/nests/:id/ledger/export`, `/nests/:id/rollups`, `/surfaces/cold-start`) answer `403` to anyone else. A key scoped to the nest still reads that nest's ledger and rollups: that is an agent reading its own nest. Agents keep registering and reporting runs (`POST /nests/:id/agents`, `POST /nests/:id/run/:agent`, `POST /runs/:id/steps`, `PATCH /runs/:id`) and every `context_agent_*` and `context_surfaces_cold_start` MCP tool works as before.
