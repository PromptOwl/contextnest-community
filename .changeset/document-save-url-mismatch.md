---
"@promptowl/contextnest-community": patch
---

Fix saving an existing document navigating to the Nest Overview page while
the address bar kept the document's `?doc=<id>` URL.

Clicking **Save** on an existing document reused the same "go back to the
nest" continuation as creating a brand-new one, so every save moved the app
view to Overview without touching the URL — leaving the breadcrumb and page
out of sync with `?doc=<id>` until a reload reopened the editor. Saving an
existing document now leaves the editor open on that document; only creating
a new document still returns to the nest.
