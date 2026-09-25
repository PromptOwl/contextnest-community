---
"@promptowl/contextnest-community": patch
---

Fix the My Work sidebar badge undercounting when a pending deletion or archive
request is waiting.

`GET /me/work`'s `pagination.total` came straight from the review queue's
count, which only tallies pending reviews. Deletion and archive requests ride
the same `items`/`waiting` buckets the My Work page renders, but were never
folded into `total` — so a pending deletion/archive flag made the sidebar
badge undercount by one per flag, and a hard refresh didn't fix it since the
server was returning the wrong number, not a stale one. `total` now includes
the deletion/archive rows actually shown.
