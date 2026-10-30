---
"@promptowl/contextnest-community": patch
---

**Faster saves; moves are safe alongside other writes.** Creating or editing a document no longer reads it back from storage right after saving it (about half a second on a network-mounted vault); the server uses the copy the write just cached. Moving a document now takes the same vault lock as every other write, so a publish running at the same moment can no longer record a checkpoint in the middle of the move.
