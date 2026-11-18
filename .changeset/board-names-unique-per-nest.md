---
"@promptowl/contextnest-community": patch
---

Two boards in the same nest can no longer have the same name (ignoring case). Renaming a board to a name another board already has is refused with "A board named "X" already exists in this nest. Pick another name.", and so is sharing a private board whose name a shared board already uses. "New board" and "Duplicate" pick the next free name ("Untitled board 2", "Sprint copy 2") instead of saving a duplicate. Someone else's private board doesn't count, so its name stays hidden.
