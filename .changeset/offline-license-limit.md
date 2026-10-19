---
"@promptowl/contextnest-community": patch
---

A server that can't reach PromptOwl now keeps its last good license for 24 hours, not indefinitely. Once 24 hours pass since the last successful license check, the server goes read-only: reading keeps working, nobody is signed out, and writing comes back on the next successful check. The clock is the saved check time, so a restart doesn't reset it. Server admins and the license owner see why in a banner, in Settings → License (`offline_since` on `GET /admin/license`), in the 503 a refused write returns, and on the status page; everyone else sees the usual neutral read-only line.
