---
"@promptowl/contextnest-community": patch
---

With sign-in turned off (`AUTH_MODE=open`), a pending external edit on a public or org-visible nest that an account made before sign-in was turned off is shown again. `GET /nests/:id/external-edits`, `GET …/nodes/:id/external-edits` and `GET …/nodes/:id/external-edits/:suggestionId` answered as if there were none, so the edit could be approved or rejected but not seen. Only the local user (no credential) gets this: an API key or session sent to an open-mode server authenticates as itself and keeps every access check. With sign-in on, nothing changes: someone who reaches a nest only because it is public or org-visible still sees no pending external edits.
