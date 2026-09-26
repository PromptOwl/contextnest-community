---
"@promptowl/contextnest-community": patch
---

Fix folder names casing inconsistently between the authoring sidebar and
Reader navigation.

The authoring sidebar's `prettyFolder` title-cased every hyphen/underscore
word (`fold-er-tab` → `Fold Er Tab`), while Reader's `humanize` only
capitalized the first character of the whole slug (`Fold er tab`). Reader's
`humanize` — used for its folder section labels and breadcrumbs — now
title-cases each word the same way, so the same folder reads identically in
both surfaces.
