---
"@promptowl/contextnest-community": minor
---

Upload PowerPoint and Word files as governed documents. New `POST /nests/:id/nodes/office` (multipart `file`, `.pptx` or `.docx`) extracts the text into a markdown document — a `## Slide N: <title>` section per slide with its text, tables and speaker notes, or a docx's headings, paragraphs, lists and tables — governed exactly like a create (a draft in a governed nest). The original is kept and linked from the body; new `GET /nests/:id/originals/:file` serves it as an attachment to anyone who can read the document. Zip bombs, DTDs/XML entities and malformed packages are refused with `400` and nothing written; new `OFFICE_MAX_MB` (default 25) caps the upload. The nest's import picker and drag-and-drop accept `.pptx`/`.docx`. Node responses carry `original` on these documents.
