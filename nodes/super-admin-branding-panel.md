---
type: document
title: Super-admin branding panel (logo/app-name/tagline) — DB overrides env
tags: [community, server, improvement, developer, access]
---

# Super-admin branding panel

White-label controls editable from the UI by a server admin, instead of only
the `LOGO_URL` env var. Added 2026-06-26.

## Data flow

`server_settings` KV table (migration in `db/migrations.ts`) ← `settings/branding.ts`
(`getBranding`/`setBranding`, validation). Read path: **DB value overrides env
default** — `getBranding()` returns `{ logo_url, app_name, sign_in_tagline }`,
spread into `GET /health` (public; the login screen reads it pre-auth). Write
path: `PUT /admin/branding`, gated by `canManageStewards` (license admin OR
`access.yaml` super_admin) — the same "server admin" gate as steward management.

`logo_url` reuses the `config.LOGO_URL` allowlist (https/http/data:image only)
so a `javascript:` URL can't land in the login `<img src>`. Empty string on any
field clears the override back to env/default.

## UI

- `admin-status` now returns `me.is_super_admin` (license admin OR super_admin).
  `AuthContext` exposes `isSuperAdmin`, `appName`, `signInTagline`, and
  `refreshBranding()` (re-pulls /health after a save, no reload).
- `BrandingSettingsModal` (super-admin only) → user menu → "Branding".
- Header + `Login.tsx` now render `{appName}` and the tagline instead of the
  hardcoded "ContextNest" string. Favicon already followed `logoUrl`.

## Convention / gotcha

Branding belongs on `/health` (not behind auth) because the login screen renders
it before the user authenticates. The server-admin gate is `canManageStewards` —
reuse it for any new server-wide control rather than inventing a new check.

Local run note: the dev server must be launched **detached / unsandboxed** to
survive across agent tool calls — a plain backgrounded `node dist/index.js` gets
torn down. See [[community-nest-launch-gotchas]].
