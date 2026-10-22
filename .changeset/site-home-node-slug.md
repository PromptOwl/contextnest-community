---
"@promptowl/contextnest-community": patch
---

Public docs site: the reader-mode home node now resolves on the static site (`/d/<key>/`) exactly as it does in the reader — by full node id or bare slug (`welcome` finds `nodes/docs/welcome`), case-insensitively. Before, the site matched the exact id only, so a slug or different-case `home_node` was ignored and the site could open on a different page than the reader. When several pages share the slug, both now pick the lowest node id.
