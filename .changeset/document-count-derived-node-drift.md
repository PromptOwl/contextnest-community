---
"@promptowl/contextnest-community": patch
---

Fix a nest's document count drifting above the number of files it holds.

Commenting on an artifact creates the derived `— Annotations` node that carries the feedback into the context path. Every listing hides it — that is the point — but three counts didn't: the dashboard card, the dashboard's running total, and the document count MCP's `nest_index` reports to an agent all counted it as a file. So a nest read one document high per commented artifact, and the gap never closed, which looks exactly like a stale cache.

The exclusion is also case-correct and consistent across backends. SQLite's `LIKE` folds ASCII case and ignores collation, Postgres's doesn't — so a document imported from a file named `Deck--Annotations.md` (imports keep a file's case in its id) was dropped from the count on SQLite and kept on Postgres. It is a real document either way, and now counts on both.

The card's "recent activity" still reflects a comment — a comment is activity on the nest, even though it isn't a file. A document a person actually titled something ending in "Annotations" is still a file and still counts.
