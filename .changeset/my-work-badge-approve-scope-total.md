---
"@promptowl/contextnest-community": patch
---

Fix the My Work sidebar badge overcounting relative to what the My Work page
actually shows.

`GET /me/work`'s `pagination.total` was the raw `getReviewQueue` count: every
pending review in every nest the caller can *see*, regardless of who
requested it or whether the caller can approve it. But `items`/`waiting`
only ever surface a review that is the caller's own request or one they can
actually approve — a viewer/editor's nest with someone else's pending review
inflated `total` without that review ever appearing in either bucket. The
approve-capability check was also only resolved for nests appearing in the
current page of results instead of every nest the caller can see, so the
undercount/overcount shifted depending on pagination. `pagination.total`'s
review portion is now computed the same way `items`/`waiting` are: pending
reviews in nests the caller can approve, plus the caller's own pending
reviews elsewhere.
