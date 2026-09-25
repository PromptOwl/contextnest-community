---
"@promptowl/contextnest-community": patch
---

Fix Board "Columns by: Folder" labels hiding the actual folder name for deeply nested paths.

Showing the folder column's full path (see previous fix) solved ambiguous
same-leaf-name folders, but for a path many subfolders deep the header's CSS
truncation elides from the end — hiding the leaf, the one segment that
actually names the folder, behind the ellipsis. Folder column labels now
shorten from the front instead: a long path shows `…/parent/folder` rather
than `folder-name-that-gets-cu…`, so the leaf stays visible while the
tooltip and drag/drop key still carry the untouched full path.
