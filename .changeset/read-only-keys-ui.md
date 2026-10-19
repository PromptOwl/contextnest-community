---
"@promptowl/contextnest-community": patch
---

Read-only API keys can now be made from the dashboard. The API keys page has a Read-only / Read-write choice next to the scope picker. A read-only key must be scoped to one nest, so "All your nests" is unavailable while Read-only is picked, and the page explains why inline. Every listed key now shows whether it is Read-only or Read-write next to its nest badge. The Connect dialog's "Create a key for this nest only" starts out read-only, so a key handed to an agent is least-privilege by default.
