---
"@promptowl/contextnest-community": minor
---

Custom fields, administered per nest. A nest admin, the owner or a nest-wide reviewer steward defines fields once — text, number, select, multi-select, date, person, link or checkbox — for the nest's tasks (or every node type). Values are stored in each node's frontmatter, so every change is versioned and hash-chained with the document and goes through the usual review rules; one validator covers REST, MCP and the web UI.

Estimate (a number on a points or hours scale) and Time in status (computed from when a task entered its current column) are one-click presets. Boards group, lane and filter by select, person and checkbox fields; cards show field values and an open document gets a Fields panel. Agents get `context_fields` / `context_create_field` / `context_update_field` / `context_delete_field`, `fields` on `context_create` / `context_update`, a `fields` filter on `context_list`, and values on get / list / query. Migration 062 adds `field_definitions`.
