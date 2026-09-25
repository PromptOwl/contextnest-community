---
"@promptowl/contextnest-community": patch
---

Fix a YouTube/Vimeo (or uploaded video) URL placed right after an image losing its embedded player after save + reload.

The editor's image node is configured as a top-level block so `![alt](url)`
round-trips through markdown, but its serializer never closed its block —
so the paragraph written immediately after an image (a bare video URL) had
no blank line separating it from the image line. On reparse, CommonMark's
lazy-continuation rule folded the two into one paragraph, so the video URL
was no longer alone in its paragraph and Preview rendered it as a plain
link instead of an embedded player. The image serializer now closes its
block like every other block-level node does.
