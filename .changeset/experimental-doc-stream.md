---
"@promptowl/contextnest-community": minor
---

Experimental: a cross-nest document stream. With `EXPERIMENTAL_DOC_STREAM` on (or a superadmin's new "Document stream (experimental)" switch under Settings → Features), a Stream page and a Stream tab on each nest show every document version across the nests a person can read, newest first, filterable by nest, topic, type and author, with the document's open comment threads and a composer inline. New endpoint `GET /me/stream`; `/health` reports the switch as `experimental.doc_stream`. Off by default; may change or disappear.
