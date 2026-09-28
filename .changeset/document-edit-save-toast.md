---
"@promptowl/contextnest-community": patch
---

Show a success toast after saving edits to an existing document. The save
navigates back to the nest before the editor's "Saved" hint could be seen, so
there was no confirmation the changes were stored. A save with no changes
keeps its existing "no changes" message.
