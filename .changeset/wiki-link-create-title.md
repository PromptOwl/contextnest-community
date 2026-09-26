---
"@promptowl/contextnest-community": patch
---

Fix the New Document form prefilling with the internal node id
(`nodes/<id>`) instead of the wiki-link's human-readable title when clicking
a broken `[[Title]]` link.

Aliased wiki-links store `[[nodes/<id>|Title]]` — the internal node id as
the target, the readable title as the display alias. Once the target
document was deleted, the click handlers fell back to that raw target for
the create/blocked title instead of the alias, leaking the internal id into
the New Document form (and into the reviewer's "doesn't exist" message).
Broken links now prefill with the link's display text.
