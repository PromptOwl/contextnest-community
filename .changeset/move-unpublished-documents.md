---
"@promptowl/contextnest-community": patch
---

Moving a document that isn't published no longer fails. A document stored with
an empty tag list reads back with an undefined `tags` value, which the YAML
serializer refuses to write — so every draft and pending-review move errored out
while published documents (already cleaned by the publish path) moved fine. The
same clean now runs on every write of a document that came from storage, which
also covers the two import paths that reset a broken version chain or persist
import metadata. The Documents list stops hiding "Move to folder" on a document
awaiting review: owners, admins, and reviewers assigned to it are the callers the
server already lets move one, and they now see the action.
