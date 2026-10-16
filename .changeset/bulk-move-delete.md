---
"@promptowl/contextnest-community": minor
---

Documents can be selected in the Documents list and moved, tagged or deleted together. Adds `POST /nests/:nestId/nodes/bulk-move` and `/bulk-delete`, and an `ids` list on MCP `context_move` and `context_delete` (tags: `context_bulk_update`). Each document is its own governed write, so ones under review or that the caller can't change are skipped and reported per document while the rest go through.
