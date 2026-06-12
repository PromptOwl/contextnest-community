---
"@promptowl/contextnest-community": minor
---

Central marketplace registry — cross-server pack distribution.

- `MARKETPLACE_REGISTRY_URL`: point any community server at a central registry (itself just a community server — one codebase) and its approved packs appear in the local storefront with a "PromptOwl Marketplace" badge.
- `GET /marketplace/packs/:id/files` serves an approved pack's importable files for cross-server installs (public-readable; approved packs only).
- `POST /marketplace/install-remote/:packId` pulls a registry pack's files over HTTP (timeout-bounded, path/size-validated) and imports them locally with provenance.
- Installs now stamp the pack's pricing meta onto the installed copy, so per-call metering resolves locally — even when the source pack lives on another server or is later delisted.
