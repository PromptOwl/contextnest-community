---
"@promptowl/contextnest-community": minor
---

Deletion requests are editor-only — viewers no longer see the action at all.

Flagging something for deletion used to be read-tier, on the reasoning that
whoever notices dead content usually can't delete it. In practice that handed
the action to everyone who could merely *see* a document — read-only
collaborators, viewer stewards, and now anyone holding a read share grant — and
produced requests from people with no stake in the content. Someone who cannot
change a document has no standing to propose destroying it.

Now: `POST /nests/:id/nodes/:nodeId/request-deletion` and
`POST /nests/:id/request-deletion` require **editor** authority, meaning any of
the three paths that already let someone change the target — nest-wide `write`,
an editor steward row covering it, or a `write` share grant on it. A folder or
nest flag additionally wants a **nest**-scope steward row: a row scoped to one
document is no mandate over everything around it. Below that the answer is
`403`, after the existing read check, so the gate never doubles as an existence
oracle. Deleting outright is unchanged (owner/admin, or the document's author).

The rule lives in one predicate (`canRequestDeletion`) shared by the REST routes
and the `context_request_deletion` MCP tool, so the agent surface can't become
the way around it.

In the UI the action is withheld rather than offered and refused: no Delete
entry on a document's ⋯ menu or list row for a viewer, no request affordance on
a folder row, and no nest-level Delete for viewers or reviewer-only stewards.
