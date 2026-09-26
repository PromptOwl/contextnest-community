---
"@promptowl/contextnest-community": patch
---

Fix the header breadcrumb overflowing the page for a nest with a very long,
space-less name.

A crumb's label only truncates once it's allowed to shrink below its text's
own width — as a flex item it wasn't, so an unbreakable name rendered at
full width, pushing the page past the viewport and leaving a horizontal
scrollbar with blank space past the (now too-narrow) header divider. Crumb
labels now shrink and ellipsize instead.
