---
"@promptowl/contextnest-community": patch
---

Update `@promptowl/contextnest-engine` to 3.0.0. Community picks up the engine's structure rules (enforced folder layout, naming and templates when a nest owner turns them on), stricter document ids (no new documents under a root `packs/` folder, no `\` or control characters, ids up to 1024 characters), safer imported forgets, vaults that keep working when one file is unreadable, and large documents that no longer stall the server on publish. The one breaking engine API (`applyImportedTombstones`) isn't used here, so no Community code changes were needed.
