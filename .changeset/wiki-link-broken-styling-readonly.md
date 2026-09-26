---
"@promptowl/contextnest-community": patch
---

Fix unresolved `[[…]]` links losing their broken-link styling in read-only views.

The editor already styles an unresolved `[[Title]]` link differently (purple,
dotted underline) from a resolved one (blue, solid), but the read-only
renderer used by the "Preview" toggle, Comment mode, and the nest View mode
rendered every link as resolved regardless of whether it actually pointed at
a document. Both now resolve the target the same way the hover preview does
and fall back to the broken-link style when it doesn't.
