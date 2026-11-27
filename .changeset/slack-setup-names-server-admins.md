---
"@promptowl/contextnest-community": patch
---

Slack setup names the server admins in a channel. A server admin can open every nest that is not sealed, so the channel check counts them as readers and does not offer "Add to nest" for them. The channel step now lists them under "Server admins. They can open <nest> by link, so they don't need adding:", so a missing "Add to nest" button is explained. New: `people.server_admins` on `POST /surfaces/bindings/preview`.
