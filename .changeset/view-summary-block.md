---
"@promptowl/contextnest-community": minor
---

View pages now render `summary` blocks: a model-written summary of the documents a selector matches, labeled "Generated summary" and listing the `id@version` of every source. It covers the approved version of each document, is cached against that exact set plus style and model, and regenerates only when one of them changes. A selector matching more than `max_nodes` (default 25) covers the first ones by id and says so. Each generated summary is a model call on the nest's model key, so it uses credits on PromptOwl's gateway.
