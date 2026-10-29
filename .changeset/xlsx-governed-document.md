---
"@promptowl/contextnest-community": patch
---

**Upload Excel workbooks as governed documents.** An `.xlsx` now imports like a `.pptx` or `.docx` — from the nest's Import and drag-and-drop, `POST /nests/:id/nodes/office`, and MCP `context_upload`. Each worksheet becomes a `## Sheet: <name>` section holding a markdown table (header row first; formulas show their calculated value; date-formatted cells read as dates), capped at 500 rows and 50 columns per sheet with a note naming what was cut. The original stays downloadable, and the same zip-bomb and XML guards apply. Legacy `.xls`, charts and pivot tables are not imported.
