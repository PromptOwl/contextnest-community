---
"@promptowl/contextnest-community": patch
---

Moving a document no longer fails with a duplicate-key error when the destination id still has version history from a document that was removed outside the app. Move now clears those leftover rows first, the same way create already did, so folder reorganization works on older vault content and the moved document never picks up a stranger's history, comments or watchers.
