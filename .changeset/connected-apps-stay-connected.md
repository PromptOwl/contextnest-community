---
"@promptowl/contextnest-community": patch
---

Connected apps stay signed in. An MCP client that signed in without asking for `offline_access` (a local app on a `localhost` redirect, typically) got a one-hour token and nothing to renew it with, then silently dropped off **Connected apps**. Every sign-in now includes `offline_access`, so every client gets a refresh token; the consent screen lists it, and a client that never refreshes just ignores it. An app whose sign-in does run out is now listed as **Expired**, with a hint to reconnect from the app and a **Remove** button, instead of vanishing. Expired grants are kept 30 days for this, and an expired row is hidden once the same app has reconnected. Apps connected before this release have to reconnect once.
