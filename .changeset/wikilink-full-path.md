---
"@promptowl/contextnest-community": patch
---

Wiki links inserted from the editor carry the document's full path. The `[[` picker and the link dialog wrote `[[nodes/<slug>|Title]]` with the folder dropped, so a link to a page inside a folder pointed at a path that did not exist and only resolved by luck of the slug. They now write the full node id; existing short links still open through the slug fallback.
