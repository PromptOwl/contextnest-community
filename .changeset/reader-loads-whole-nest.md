---
"@promptowl/contextnest-community": patch
---

Reader Mode shows the whole nest on first load. The public reader fetched only the root level and the first top-level folder, so every other folder sat collapsed until a visitor clicked it, and a home page that lived in a later folder never resolved — the reader opened empty. It now reads the nest's document list in one metadata-only request, lists every folder expanded, and opens the designated home page wherever it lives.
