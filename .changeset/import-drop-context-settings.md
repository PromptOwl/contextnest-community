---
"@promptowl/contextnest-community": patch
---

**Importing an exported nest no longer reports a false failure.** A nest export includes the source vault's `.context/config.yaml`, which the engine never imports (it holds that vault's own settings), so every import of one ended with "Imported, but 1 file could not be read or was too large: .context/config.yaml". Import now drops `.context/` before staging, the same way it drops `_suggestions/`, so a clean import reads as clean.
