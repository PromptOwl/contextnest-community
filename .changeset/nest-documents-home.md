---
"@promptowl/contextnest-community": minor
---

Documents is now the nest's one home. The Overview tab is gone: a nest opens on Documents, and an old `?tab=overview` link opens Documents. Documents gains Overview's summary line (documents, folders, edited this week, and the governance counts on a governed nest) and a "Recently edited" feed above the list. Every feed item and every row (list and grid) shows when it was last edited and who edited it, the human first and the agent second ("Priya Raman via mkt-amplifier"). Fields, the Reader mode switch and the list/grid switch move into the nest header's ⋯ menu; Fields opens as a dialog, and `?tab=fields` still opens it. The node list (`GET /nests/:nestId/nodes`) and the census feed now carry `last_edit` on each document. MCP `context_list` ends each row with "edited by <human> via <agent>, <date>" (prose only until the engine catalog has a provenance field). All of it is withheld from public readers and headless keys.
