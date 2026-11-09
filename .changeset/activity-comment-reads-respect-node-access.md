---
"@promptowl/contextnest-community": patch
---

The activity and comment reads now answer only for documents the caller can read. `GET /nests/:id/activity` leaves out entries for documents the caller can't open, and `GET …/nodes/:id/activity`, `GET …/nodes/:id/comments` and `GET …/nodes/:id/task-log` answer with an empty list for such a document, the same as for one that doesn't exist. This affects people who reach a nest only because it is public or org-visible (they get approved documents' entries only) and callers below write for a document proposed from chat that is still pending. People added to the nest see what they saw before.
