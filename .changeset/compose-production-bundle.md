---
"@promptowl/contextnest-community": patch
---

**Production Docker Compose bundle.** `deploy/compose/` runs ContextNest Community, PostgreSQL and Caddy (automatic HTTPS) on a single VM: copy `.env.example` to `.env`, set the host name and database password, then `docker compose up -d`. Includes healthchecks on `/readyz`, restart policies, named volumes, and upgrade and backup steps in its README. CI smoke-tests the bundle end to end over HTTPS.
