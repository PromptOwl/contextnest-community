---
"@promptowl/contextnest-community": patch
---

Every nest now has its own URL: `/nest/<id>`.

Until now a nest — public or private — was only reachable as `/?nest=<id>`, a query-string deep link into the app shell, so there was nothing clean to share, embed, or bookmark. The app now writes the path form for every nest-scoped view (documents, graph, workflows, board, trace keep their `?doc=` / `?view=` / `?tab=` parameters after it), and the document "Copy link" action produces it too. Old `?nest=<id>` links and the links in notification emails keep working: they resolve the same way and are rewritten to the path form on load.
