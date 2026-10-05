---
"@promptowl/contextnest-community": patch
---

Reviewers can now read a held push before confirming it. In the review dialog, clicking a document shows its full content, a staged context.md can be expanded, and a summary counts how many documents are new and how many are updates. `GET /nests/:id/pending-pushes/:pid` now returns each manifest row's `content` and the push's `context_md`. The list endpoint is unchanged.
