---
"@promptowl/contextnest-community": minor
---

`POST /nests/:id/context` with a `prompt` returns the documents relevant to it, ranked — not the neighbourhood, and not the nest.

**Bodies count.** The prompt compiler matched tokens against tag names and titles only, so a natural-language question ("how do I run a conflict check?") usually compiled to nothing and came back empty — which pushed callers into dumping the whole nest as a stand-in — or compiled to one weak title while the real answer sat in another document's body. Every document is now scored against the prompt (title hits weigh most, then tags, then body words), unioned with the compiled matches, and anything under half the top score is dropped as noise. A prompt that matches nothing — a greeting — returns `nodes: []`. `trace.compiled.fallback` is `"fulltext"` when body scoring alone produced the answer.

**No hop noise by default.** A prompt used to inherit `hops: 2`, so every keyword match dragged in two hops of wikilink neighbours as full nodes, indistinguishable from the match — and a caller citing every node returned cited them all. The prompt path now defaults to `hops: 0`; pass `hops` to expand. Explicit `selector` requests keep their `hops: 2` default.

**Per-node relevance.** On the prompt path each entry in `nodes` carries `score` (0–1) and `via` (`"title"`, `"tag"`, `"fulltext"`, or `"hop"` for a neighbour pulled in by an explicit `hops`). `nodes` and the `context` blocks are ordered by score. Additive: selector-path responses are unchanged.

**The budget fills instead of stopping.** Budget-fitting used to stop at the first document that didn't fit, so one large document early in the list left the rest of `max_tokens` unused — a 38-document match could come back as one. A document that doesn't fit is now skipped and the next is tried; only when nothing fits at all does the best match go through oversized, so a non-empty result is never an empty answer. `GET /nests/:id/export?max_tokens=` fills the same way.
