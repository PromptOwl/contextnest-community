---
"@promptowl/contextnest-community": minor
---

Upload PDFs as governed `pdf` documents.

`POST /nests/:id/nodes/pdf` (multipart `file`) turns a PDF into a document whose body is the PDF's extracted text — what agents read through `context_get`, which now also says `**Source file:** PDF, N pages` (and `no text layer` for a scan). The PDF itself is kept beside the document and bound to each version by sha256 (engine `context_import_pdf`, `@promptowl/contextnest-engine` 2.7). Uploads go through the same stewardship as any create or edit: a draft in a governed nest, a new version when the PDF is replaced. `GET /nests/:id/nodes/:nodeId/pdf` serves the binary through the node's read gate, so a public reader only ever gets the approved version's PDF.

In the app: Import → "Upload PDF", or drop a `.pdf` on the vault. A PDF document shows the PDF in the browser's viewer above its extracted text (read-only), with Download and Replace PDF, and a warning when the PDF has no text layer. New setting `PDF_MAX_MB` (default 25).
