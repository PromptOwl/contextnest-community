---
"@promptowl/contextnest-community": minor
---

Control room dashboard (po-1186 CR2): the Overview (tiles, distillation by day with the no-proposal reasons, cold start, channels with the paused-channel alert, rollups), the Decision ledger (filters, totals, CSV export, a trace drawer from the run to the saved version) and Agents (every agent that reported, external ones included, plus how to connect one). Nest owners and admins now see the Control room for the nests they administer; Setup stays server-admin only. New read route `GET /surfaces/cold-start` (MCP `context_surfaces_cold_start`); rollups gain `by=reason` and `last_at` / `source` on every row.
