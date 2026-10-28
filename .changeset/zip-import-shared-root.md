---
"@promptowl/contextnest-community": patch
---

Importing a .zip made by compressing a folder now keeps the folder's CONTEXT.md as the nest's instructions. Such a zip wraps every file in the folder's name, and the import kept that wrapper, so CONTEXT.md landed in a subfolder and the Instructions page stayed empty. The wrapper is now dropped, the same way picking the folder directly already did, and documents land where they sat in the folder. Exported ContextNest bundles, which keep `nodes/` at the top, are imported unchanged.
