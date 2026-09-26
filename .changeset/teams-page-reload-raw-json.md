---
"@promptowl/contextnest-community": patch
---

Fix reloading (or directly opening) `/teams` showing the raw Teams API JSON
instead of the Teams page.

The client's Teams page URL is `/teams`, which collides with the top-level
`GET /teams` API route — in-app navigation never re-requests it, but a hard
reload or a bookmarked link issues a real `GET /teams`, which the API route
answered first with `{"teams": [...]}` instead of the app shell. A guard ahead
of the `/teams` route now serves the SPA shell for a real browser navigation
(same document-navigation check the SPA catch-all already uses) and leaves
the app's own API fetches untouched.
