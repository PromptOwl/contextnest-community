---
"@promptowl/contextnest-community": patch
---

Fix dragging an unsupported file (SVG, PDF, .txt, ...) into the document editor: the "Drop to add an image or video" overlay is now skipped when the browser's drag-over MIME type identifies the file as unsupported, and dropping one now shows a toast naming the file and the accepted types instead of silently doing nothing.

The drop overlay only checked whether the drag carried files at all, not
whether any of them were an accepted image/video type, and `handleDrop`
returned early for a rejected file without any feedback — worse, without
calling `preventDefault()`, letting the browser fall back to navigating the
tab to the dropped file.
