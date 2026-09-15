---
"@promptowl/contextnest-community": minor
---

Manage multiple official community site SSO connections from Server Settings, instead of just one.

Server admins previously configured a single official community site for one-click SSO auto-login via the `OFFICIAL_COMMUNITY_SSO_SECRET`/`PUBLIC_BASE_URL` env-var pair. **Settings → Community sites** now lets an admin add, edit, enable/disable, and remove any number of sites, each with its own name, URL, and secret (`GET/POST/PATCH/DELETE /admin/community-sites`, server-admin only — see `API.md`). `GET /auth/sso` tries an incoming ticket's signature against every active site's secret and validates its audience against that site's URL, so a ticket minted for one site can't be replayed against another.

The legacy env-var pair still works as an implicit extra site, so existing single-site deployments are unaffected — nothing to migrate.
