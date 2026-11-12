---
"@promptowl/contextnest-community": minor
---

Documents is now the nest's one home. The Overview tab is gone: a nest opens on Documents, and an old `?tab=overview` link opens Documents. Documents gains Overview's summary line (documents, folders, edited this week, and the governance counts on a governed nest) and a "Recently edited" feed above the list. Every feed item and every row (list and grid) shows when it was last edited and who edited it, the human first and the agent second ("Priya Raman via mkt-amplifier"). Fields, the Reader mode switch and the list/grid switch move into the nest header's ⋯ menu; Fields opens as a dialog, and `?tab=fields` still opens it. The node list (`GET /nests/:nestId/nodes`), the census feed and MCP `context_list` now carry `last_edit` on each document, withheld from public readers and headless keys.
