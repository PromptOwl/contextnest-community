---
"@promptowl/contextnest-community": minor
---

Folders can now be renamed and moved. Owners and admins get a rename/move action on each folder in the Documents tree, `POST /nests/:nestId/folders/move`, and `context_move` with `from_folder` over MCP. Everything under the folder (sub-folders, empty ones too) follows: ids change, version history, review state and links are kept, and the nest's structure rules are enforced.
