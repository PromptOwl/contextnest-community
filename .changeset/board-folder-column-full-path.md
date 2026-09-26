---
"@promptowl/contextnest-community": patch
---

Fix Board's "Columns by: Folder" labeling nested folders with only their leaf
segment.

A folder column's label shortened to its own name unless it collided with
another folder of the same leaf name — so `no/such/folder` showed as just
`folder`, dropping the hierarchy, and only actual leaf-name collisions ever
grew back a distinguishing prefix. Folder column labels now always show the
full folder path, matching the tooltip.
