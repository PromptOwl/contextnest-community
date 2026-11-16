---
"@promptowl/contextnest-community": minor
---

The experimental document stream (`/stream` and the nest Stream tab) is now a dense feed. Each post shows an avatar, the person's name (not the email), "via <agent>" when the write named one, the nest, a compact time, what happened in one line with the change note, and a one-line excerpt. Reply, open and copy link sit on every post; Approve and Request changes appear on an in-review post for a reader who may review. Filters are one row: an All / People / Agents toggle, the active chips and a Filter menu. A "N new posts" pill polls a cheap `since` read. The nest Stream tab no longer shows the Total Documents tile. `GET /me/stream` adds `authorName`, `client`, `changeNote` and `review` on items, and the `source=agent|human` and `facets=0` query params. New MCP tool `context_stream` reads the same feed.
