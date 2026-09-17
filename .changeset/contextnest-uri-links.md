---
"@promptowl/contextnest-community": patch
---

`contextnest://` links in a document open like wiki links. A bare `contextnest://nodes/gtm/deals` in the text, or a `[label](contextnest://nodes/…)` link, now renders as a link to that page in the reader and the document view — click opens it, hover previews it. A `@checkpoint` pin or `#anchor` on the URI is ignored for resolution; tag, search and folder URIs have no page to open and stay plain text.
