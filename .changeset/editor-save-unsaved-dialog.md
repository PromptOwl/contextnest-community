---
"@promptowl/contextnest-community": patch
---

Fix the "Unsaved changes" dialog appearing right after saving a document.

Saving navigates back to the nest, and that navigation is checked by the
unsaved-edits guard. The save had already cleared the dirty flag, but React had
not re-rendered yet, so the guard still saw the document as dirty and opened
the leave dialog — asking the user to save the edits it had just written, with
the save button reading "Saved" behind it.

A save is the answer to that question, so every save path now runs its
follow-on navigation past the guard. Discard and "Save & leave" already did;
the plain Save button was the one path that did not.
