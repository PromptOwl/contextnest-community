---
"@promptowl/contextnest-community": minor
---

Public Docs Reader Mode, and an acknowledgement before a nest goes public.

**Reader Mode** is a superadmin switch (`PATCH /nests/:id/reader-mode`) that
changes how a nest reads for people who can only read it. With it on, a viewer
gets a clean three-pane docs reader — navigation, the document, and a persistent
home pane — instead of the authoring shell, and the board, ontology graph and
definitions tabs disappear. Owners, editors, reviewers and admins are unaffected
and keep the full tabbed UI, so the same nest is a docs site to its readers and a
workspace to its stewards. An optional home node names the landing document;
unset, it resolves by convention.

Reader Mode is presentation only. It hides authoring surfaces from people who
already could not use them — it grants nothing and gates nothing, and access
control is unchanged.

**Making a nest public now takes an explicit acknowledgement.**
`PATCH /nests/:id/visibility` with `visibility: "public"` returns `409
requires_acknowledgement` unless the request also carries `acknowledge_public:
true`; the UI asks first, in the same words the server answers with — the nest
becomes readable by anyone on the internet, outside your organization. Going back
to private is unguarded.

**Breaking, for API callers:** an existing integration that flips a nest to
public with `{ "visibility": "public" }` alone now gets a `409` and no change.
Add `"acknowledge_public": true` to that request. Reads, private-visibility
calls, and every other nest endpoint are untouched.
