---
"@promptowl/contextnest-community": minor
---

Experimental document pins, behind their own superadmin switch (`EXPERIMENTAL_DOC_PINS`, Settings → Features → "Document pins (experimental)", off by default). Stewards pin documents to the front of a nest for everyone, in an order they choose; anyone who can read a document can pin it for themselves. Pins show as a strip above the nest's document list, with a pin control on each document's header and on its row in the document list. New `/nests/:id/pins` endpoints; `/health` reports `experimental.doc_pins`. May change or disappear.
