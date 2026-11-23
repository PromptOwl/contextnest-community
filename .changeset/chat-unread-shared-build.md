---
"@promptowl/contextnest-community": patch
---

Unread badge polls no longer pile up (po-1466). `GET /me/chat/unread` and the `chat` section of `GET /me/work` share one summary build per person while it runs, instead of each poll starting its own. The summary is cached for 30 seconds (was 5), the same as the document-discovery cache, and its per-nest work runs in parallel. On a one-instance deployment the slow polls had filled every request slot and Cloud Run answered 429. The unread count can now be up to 30 seconds old. No API change.
