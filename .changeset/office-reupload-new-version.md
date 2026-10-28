---
"@promptowl/contextnest-community": patch
---

**Re-upload an Office file as a new version of its document.** `POST /nests/:id/nodes/office` with `nodeId` (MCP `context_upload` with `node_id`) turns an updated .pptx, .docx or .xlsx into the next version of the document it created, instead of a second document: new text and new original, through the normal edit and review path (a draft in a governed nest). Earlier originals stay downloadable from their versions, a public reader only ever gets the approved version's file, and the response warns when hand edits to the document were replaced.
