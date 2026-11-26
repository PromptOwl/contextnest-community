---
"@promptowl/contextnest-community": patch
---

The Members panel of a public channel now shows everyone who can read and post there: people who joined first, then "Also have access" with the rest of the nest, and a count of both. `GET /nests/:nestId/channels/:name/members` adds `audience` (empty for a private channel).
