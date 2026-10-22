---
"@promptowl/contextnest-community": patch
---

Device login: `POST /auth/device/poll` now accepts `code` and `client_secret` in a JSON body, so the secret no longer has to appear in a URL where server and proxy logs can record it. The web app's PromptOwl sign-in now polls this way. `GET /auth/device/poll` with query parameters still works for older CLIs but is deprecated.
