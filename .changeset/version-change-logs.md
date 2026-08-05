---
"@promptowl/contextnest-community": minor
---

Per-version change logs instead of full-body copies. The version list
(`GET /nests/:id/nodes/:nodeId/versions`) now returns each version's stored
unified diff rather than reconstructing every body — opening the history panel
of a long-lived document no longer replays the whole chain once per row and
ships N full copies of the text. One body is fetched on demand from the new
`GET /nests/:id/nodes/:nodeId/versions/:version`, which answers `200` with
`content: null` when a version's chain can no longer be replayed, so one
unreadable row doesn't fail the panel.

Three fixes ride along. Draft saves now number through the engine's
`nextVersion()` instead of the SQLite row count, closing the case where a DB
lagging `history.yaml` grafted a second chain onto the first (duplicate
versions, overwritten keyframes, "(no content)" from the graft point on) — a
gated one-shot startup pass re-anchors documents already in that state and
moves inline patches out into standalone `v{N}.diff` files. A duplicate
`/versions` handler that shadowed the governance route is removed, so
`resolvedBy` reaches the UI. And the diff viewer's line numbers no longer skip
two, having learned to read the engine's `Index:` / `===` preamble as a header.

Requires `@promptowl/contextnest-engine` 1.3.0.
