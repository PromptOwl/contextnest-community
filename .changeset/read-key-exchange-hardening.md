---
"@promptowl/contextnest-community": patch
---

Tighten scoped read keys and the PromptOwl ticket exchange.

- **Read keys can't chat.** `POST /nests/:id/chat` can post a mention comment and spends model credits, so read-only keys now get 403 there. They still read, query, search and export.
- **`/auth/keys/exchange` is read-only and PromptOwl-only.** It accepts only `OFFICIAL_COMMUNITY_SSO_SECRET` tickets (not `MCP_SIGNING_SECRET`) and refuses `capability: "write"` (400).
- **Exchange is throttled.** Per-IP rate limit (429), and concurrent exchanges for the same user and nest are serialised so the 20-key cap holds.
