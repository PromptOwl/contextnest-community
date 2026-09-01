---
"@promptowl/contextnest-community": patch
---

Six Community bug fixes across stewards, tables, annotations and definitions.

**Assign Steward no longer opens on an unsubmittable form.** In a nest with no tags the dialog defaulted to the tag scope, whose picker had nothing to offer — the only way through was to discover the scope selector. It now falls back to the nest-wide scope once the tag list comes back empty, and the tag scope is unselectable while there are no tags.

**Commenting on an artifact is no longer authoring a document.** The annotation projection an artifact comment mints counted as a first-class document everywhere: documents list, board, graph, search, tag facets and the nest's total. It is still a real node — that is how an agent reads the feedback back on the next iteration — but every user-facing surface now leaves it out. MCP still sees it.

**Replacing a definition keeps its linked tag.** Re-defining an existing term from the add form also cleared the tag it already carried, because an empty tag box was sent as an explicit "remove". Blank now means "not specified" when replacing, and still means "remove" when editing a row whose tag field was prefilled.

**Typed table columns are checked.** The CSV preview rendered duplicate `:key` values and non-numeric `:number` cells as ordinary rows, so a typed header looked enforced when nothing checked it. The preview now says what disagrees with the header. Advisory rather than a save gate: a human-maintained fact store with one bad cell is still worth saving, and blocking would break saving already-imported tables.

**Version compare renders a table as a table.** In Rendered mode a table document's CSV went through the markdown renderer and collapsed into a single run-on paragraph with no sign of what changed. Each version now renders as the grid the reader sees, with the rows the other version lacks tinted.

**The documents type filter reads in title case.** The newer table and tool types had no display label and fell through to the raw type name, in both the dropdown and the active filter chip.
