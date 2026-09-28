---
"@promptowl/contextnest-community": patch
---

Fix the Teammates page "Last active" ignoring web-app activity. It only read
API-key usage, so someone working in the web app never moved it. It now takes
the latest of API-key use and web-session activity.
