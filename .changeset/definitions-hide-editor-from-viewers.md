---
"@promptowl/contextnest-community": patch
---

Hide the definitions editor from viewers instead of refusing them after the click.

The Definitions page rendered the full "Define term" form, plus per-row edit and
delete buttons, to everyone who could open the nest — including read-only
collaborators, public readers, and share grantees. Writes were already refused
server-side (`POST`/`DELETE /nests/:id/definitions` are write-tier), so a viewer
could fill in a term and a definition, press the button, and get a toast telling
them it wasn't theirs to do. The page even documented that as the design.

Viewers now get the glossary read-only: no form, no row actions, and an empty
state that doesn't invite them to write one. The gate is derived from
`deriveNestCaps` on the nest read every other nest screen already makes, and is
deliberately `canManage || collabCanWrite` rather than the looser `canEditDocs` —
the steward-editor bypass in the middleware covers `/nodes` routes only, so a
nest-scope editor steward without a write collaborator row is refused here by
the server too, and the UI now says so up front.

No server change: the existing read-tier denial is unchanged and still covered
by `test/definitions.test.ts`.
