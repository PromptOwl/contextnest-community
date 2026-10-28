---
"@promptowl/contextnest-community": patch
---

Browser Back and Forward now move between pages inside the app. Going from the dashboard into a nest, to its board, and into a document each adds a history entry, so Back returns to the page you came from instead of leaving the app. Switching tabs or filters on the same page still doesn't add entries, and the unsaved-changes prompt on Back keeps working.
