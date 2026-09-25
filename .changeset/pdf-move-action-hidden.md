---
"@promptowl/contextnest-community": patch
---

Hide "Move to folder" for PDF documents instead of offering an action the server always rejects.

A pdf node's binary is bound to its id, so `src/nodes/service.ts`'s
`moveNode` refuses every PDF move with "PDF documents can't be moved to
another folder yet." The UI didn't know that: both the document editor's
overflow menu and the documents-list row menu/drag-and-drop still offered
Move on a PDF, walking the user through a dialog that could never succeed.
Move is now withheld for PDF documents in both places (shared logic in
`nodeTypeSupportsMove`); every other action is unaffected.
