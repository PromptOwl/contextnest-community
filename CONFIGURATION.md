# Configuration

All server configuration is driven by environment variables. Set them in your shell, in a `.env` file, in a Docker image, or via your process manager — however you deploy the rest of your stack.

## Auth modes

The server supports two authentication modes. You pick one per instance with `AUTH_MODE`.

### `AUTH_MODE=key` (default)

Every request requires an `Authorization: Bearer cnst_...` header. Use this for any multi-user or internet-facing deployment.

- Users register via `POST /auth/register` (email + password) or log in with PromptOwl via `POST /auth/device` → `POST /auth/promptowl`.
- API keys are per-user (`cnst_<64-hex>`) and can be scoped to a single nest for service-account use.
- Rate-limited login / register / device-auth endpoints (sliding window, per IP + per email).
- First PromptOwl-authenticated user becomes the server admin (atomic claim). Admin can invite teammates at `POST /auth/invite`.

Clients include the token on every request:

```bash
curl -H 'Authorization: Bearer cnst_<your-token>' http://your-server/nests
```

### `AUTH_MODE=open`

No authentication required. Every request is attributed to the anonymous admin user (`00000000-...`). Everyone effectively owns every anon-created nest.

**Use this only when:**
- You're running locally for yourself (`bind 127.0.0.1`), or
- You're on a trusted LAN and don't care about access controls, or
- You're behind an upstream reverse proxy that already authenticates.

**Don't use this when:**
- The port is reachable from the public internet
- Multiple people share the deployment and need isolated data
- You need audit trails (every write shows up under "anonymous admin")

The server prints a loud warning at startup when `AUTH_MODE=open` is active.

---

## Full env var reference

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3838` | HTTP port the server listens on. |
| `DATA_ROOT` | `./data` (relative to cwd) | Root directory for SQLite DB + nest filesystem vaults. Set to an absolute path in production so it's independent of where you `cd`'d from. |
| `DATABASE_PATH` | `$DATA_ROOT/community.db` | Override the SQLite file location explicitly. (SQLite backend only.) |
| `NEST_STORAGE_ROOT` | `$DATA_ROOT/nests` | Root directory for nest vault files (markdown + version history). Override to store nests separately from the DB — e.g. point it at a Cloud Storage (GCS) volume mount on Cloud Run (`/mnt/nests`) while the SQLite DB stays on `DATA_ROOT` off the mount. **Moving existing nests:** the app does not relocate files — copy `$DATA_ROOT/nests/*` to the new root (e.g. `gsutil rsync`) before switching, or existing nests will appear empty (DB rows present, files missing). On a GCS mount, also set `DRIFT_SCAN_INTERVAL_MS=0` to avoid constant FUSE scans, and run a single instance (GCS FUSE has no file locking — concurrent writers lose data). |
| `DB_DRIVER` | `sqlite` | Database backend: `sqlite` (default) or `postgres`. When unset, the server infers `postgres` if `DATABASE_URL` or `CLOUD_SQL_CONNECTION_NAME` is set, else `sqlite`. Existing deployments need no change — they stay on SQLite. See [Database backends](#database-backends). |
| `DATABASE_URL` | `""` | PostgreSQL connection string for a TCP connection, e.g. `postgres://user:pass@host:5432/dbname`. Setting it selects the Postgres backend (unless `DB_DRIVER=sqlite`). |
| `CLOUD_SQL_CONNECTION_NAME` | `""` | Cloud SQL instance connection name (`project:region:instance`). When set, the server connects over the Cloud SQL Auth Proxy unix socket at `/cloudsql/<name>` — the recommended Cloud Run setup. Combine with `DB_USER`, `DB_PASSWORD`, `DB_NAME`. |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `localhost` / `5432` / `""` / `""` / `""` | Discrete Postgres connection params, used when neither `CLOUD_SQL_CONNECTION_NAME` nor `DATABASE_URL` is set. |
| `DB_POOL_MAX` | `10` | Max Postgres pool connections. Keep modest — Cloud SQL tiers cap total connections. |
| `DB_SSL` | `false` | Set `true` to require TLS on a Postgres TCP connection (not needed over the Cloud SQL unix socket, which is already secure). |
| `DB_SSL_CA` | `""` | Path to a CA certificate (PEM) for verify-ca/verify-full TLS when `DB_SSL=true`. |
| `AUTH_MODE` | `key` | `key` or `open`. See above. |
| `PROMPTOWL_API_URL` | `https://app.promptowl.ai` | PromptOwl's API origin — used for device auth, license validation, telemetry. Override for air-gapped or test setups. |
| `PROMPTOWL_KEY` | `""` | Your PromptOwl Community License key (`pk_...`). Unlicensed instances still run and serve reads, but every write returns `503` until a valid key is installed. Can also be set via the browser License Setup Page, which persists it to the database (`server_settings` table) so it survives a rebuild and reaches every instance — see [Runtime settings persistence](#runtime-settings-persistence). Setting it here in the deploy environment takes precedence on the next boot. |
| `PROMPTOWL_SIGN_IN_GATE` | `open` | Restrict "Sign in with PromptOwl". `open` = anyone may; `admin-only` = only the license owner (admin) may, everyone else uses email/password (admin opens the login page with `?admin=1`); `disabled` = nobody may. Enforced server-side at `POST /auth/promptowl` and surfaced on the health endpoint. Unknown values fall back to `open`. |
| `MANUAL_SIGN_IN` | `open` | Email + password sign-in mode. `open` = anyone may log in and self-register a new account; `invite-only` = existing/invited users may log in but brand-new self-registration returns `403` (the admin provisions accounts via invite/share/steward and shares the password — there is no self-service "set password", which would be account takeover without email verification); `disabled` = no email/password sign-in at all (`POST /auth/login` and `POST /auth/register` return `403`). Independent of `PROMPTOWL_SIGN_IN_GATE`, so the two methods are controlled separately (e.g. `invite-only` manual + `admin-only` PromptOwl). Also settable from Settings → General. The server refuses `disabled` while PromptOwl sign-in is also `disabled` (that would leave no way to log in). Unknown values fall back to `open`. |
| `OFFICIAL_COMMUNITY_SSO_SECRET` | `""` | **Official deployment only — leave unset on self-hosted.** Shared HMAC secret enabling the one-click "Open Community" SSO auto-login from PromptOwl. Must exactly match the same-named var on PromptOwl. When unset, `GET /auth/sso` returns `404` and the feature is disabled; self-hosted users keep using the manual device-code flow. |
| `PUBLIC_BASE_URL` | `""` | This server's canonical external URL (e.g. `https://community.promptowl.ai`). Two uses. (1) Checked against the SSO ticket's `aud` claim so a ticket minted for this server can't be replayed against another — whenever a ticket-signing secret is set (`OFFICIAL_COMMUNITY_SSO_SECRET` on the official deployment, `MCP_SIGNING_SECRET` on a self-hosted one); with neither set no ticket verifies at all, so the audience check is moot. (2) **Set this whenever `OIDC_ENABLED=true`.** It's the base for the OIDC `redirect_uri` sent to your IdP and replayed at token exchange. Unset, that URI is derived from the incoming request's `Host` header — fine when your proxy overwrites `Host` with a trusted value, but a proxy that passes an attacker-supplied `Host` through would feed it straight into the redirect URI. Setting this pins the value regardless of what the proxy forwards. (Your IdP's own redirect-URI allowlist is a second line of defence, not a substitute.) (3) **Set this wherever email- or invite-gated publish links are used.** The magic link mailed by `POST /p/:slug/gate` is built from it; unset, it falls back to the request origin, so a proxy forwarding an attacker-supplied `Host` would send the recipient a one-time access token pointing at the attacker's domain — the classic reset-link poisoning. (4) **Set this wherever `POST /nests/:id/context` citations reach users.** The `url` on each node and the `_source:` line in each context block are built from it; unset, they fall back to the request origin, so a proxy forwarding an untrusted `Host` would put an attacker-influenced URL in front of both the model and the reader as a trustworthy citation. |
| `OIDC_ENABLED` | `false` | Turn on generic OIDC single sign-on (`GET /auth/oidc/login` / `GET /auth/oidc/callback`). Requires `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` — the login-page button only appears once all three are set. Also editable from Settings → Single sign-on. See [Single sign-on (OIDC)](#single-sign-on-oidc). |
| `OIDC_ISSUER` | `""` | OIDC issuer URL, e.g. `https://login.microsoftonline.com/<tenant>/v2.0` (Microsoft Entra ID) or `https://accounts.google.com` (Google). **`https://` only** — a non-https value is rejected with a warning and SSO stays off. Must serve `<issuer>/.well-known/openid-configuration`. |
| `OIDC_CLIENT_ID` | `""` | Application (client) ID from your IdP app registration. |
| `OIDC_CLIENT_SECRET` | `""` | Client secret from your IdP app registration. Write-only on the Settings API — `GET /admin/settings` reports only `oidc_client_secret_set: true/false`, never the value. |
| `OIDC_ALLOWED_DOMAINS` | `""` (any) | Comma-separated email-domain allowlist, e.g. `acme.com, contractors.acme.com`. When set, only accounts whose asserted email is on a listed domain may sign in (others bounce with `domain_not_allowed`). Empty allows any domain the IdP asserts. |
| `OIDC_AUTO_PROVISION` | `true` | Create a user automatically on first successful OIDC sign-in (display name from the `name` claim). Set `false` to allow only pre-existing (invited/registered) users — unknown emails bounce with `not_invited`. |
| `OIDC_DEPARTMENT_TAGGING` | `false` | Auto-tag newly **created** documents with the creator's directory department: `dept:<slugified-department>` (lowercase, spaces → dashes, e.g. `dept:customer-success`) is appended to the document's tags, deduped against user-supplied tags. Applies on create only — never on update, never retroactively — and a user without a stored department is a silent no-op. The department is captured from the OIDC `department` ID-token claim on every SSO login (a login without the claim clears it, so directory moves propagate), so this is only meaningful when your IdP emits that claim — see [Department auto-tagging](#department-auto-tagging). Also editable from Settings → Single sign-on. |
| `SSO_TOKEN_EXCHANGE_ENABLED` | `false` | Master switch for `POST /auth/token-exchange` — an external agent exchanges an IdP ID token for a short-lived MCP bearer. Also needs `MCP_SIGNING_SECRET` and at least one provider; otherwise the endpoint returns `404`. Security-critical — see [Agent SSO (token exchange)](#agent-sso-token-exchange). |
| `MCP_SIGNING_SECRET` | `""` | HMAC secret **this** server signs its minted MCP bearers with (distinct from `OFFICIAL_COMMUNITY_SSO_SECRET`, so self-hosted deployments can issue their own). Long random string. `/index` and `/mcp` accept a ticket signed with either secret. Write-only on the Settings API. **Clearing it is the revocation switch** — turning `SSO_TOKEN_EXCHANGE_ENABLED` off stops minting but already-minted bearers stay valid until they expire. |
| `MCP_TOKEN_TTL_SECONDS` | `300` | Lifetime of a minted MCP bearer, clamped to 30–3600. |
| `MS_TOKEN_EXCHANGE_ENABLED` / `MS_CLIENT_ID` / `MS_TENANT_ID` | `false` / `""` / `""` | Microsoft Entra provider. `MS_CLIENT_ID` is the audience an inbound token must carry; `MS_TENANT_ID` must be the directory **GUID** (it builds the required issuer `https://login.microsoftonline.com/<tenant>/v2.0` — `common`/`organizations`/a domain name will not match the discovery document and every exchange returns `provider_misconfigured`). |
| `GOOGLE_TOKEN_EXCHANGE_ENABLED` / `GOOGLE_CLIENT_ID` | `false` / `""` | Google provider. Issuer is fixed (`https://accounts.google.com`); `GOOGLE_CLIENT_ID` is the audience an inbound token must carry. |
| `ENV_FILE_PATH` | `$DATA_ROOT/.env` | Path to an optional `.env` file the server reads at boot (in addition to `$cwd/.env`). **No longer used for persistence** — the License Setup Page and Settings page now write to the database, not this file (see [Runtime settings persistence](#runtime-settings-persistence)). Kept for operators who bootstrap config from a mounted `.env`. |
| `TELEMETRY_ENABLED` | `"true"` (set to `"false"` to disable) | Batched, anonymized usage events sent to PromptOwl. Off disables the loop entirely. |
| `TELEMETRY_INTERVAL_MS` | `3600000` (1 hour) | How often buffered telemetry is flushed to PromptOwl. |
| `TRACE_RETENTION_DAYS` | `14` | Activity-trace retention window in days (the `api_events` rows behind `GET /admin/trace` and `GET /nests/:id/trace`). Rows older than this are pruned opportunistically (every ~500 inserts). `0` = keep forever (pruning is skipped entirely). Capped at `3650`; invalid/negative values fall back to `14`. Also editable from Settings → Advanced. |
| `CORS_ORIGINS` | `*` in open mode; `http://localhost:5173,http://localhost:3838` in key mode | Comma-separated allowlist. Set to `*` to allow any origin (**only** safe in open mode — in key mode with Bearer tokens this enables CSRF). |
| `FRAME_ANCESTORS` | `'self'` | Which origins may embed this server in an iframe, sent as CSP `frame-ancestors`. The default lets nothing but this origin frame the UI, which blocks clickjacking. Deployments that are meant to be embedded list the embedding origin — e.g. the PromptOwl Data Room iframes ContextNest, so that install sets `FRAME_ANCESTORS="https://app.promptowl.ai"`. Comma-separated; `'self'` is always included; `*` allows any site and disables the protection. Note the embedding page must be **same-site** (a sibling subdomain) for the session cookie to survive inside the frame — a genuinely cross-domain embed will render the login page no matter what this is set to. |
| `MAX_BODY_BYTES` | `10485760` (10 MB) | Reject requests whose `Content-Length` exceeds this. Prevents giant-payload DoS. The asset-upload route (`POST /nests/:id/assets`) is exempt up to the video cap below. |
| `VIDEO_MAX_MB` | `30` | Max size (in MB) of a video uploaded into a doc. Default `30` keeps it under Cloud Run's ~32 MiB HTTP/1 request-body limit, so an oversized video is rejected with a clear message instead of a bare `413` from the platform. Raise only where the deployment can actually accept larger request bodies (not behind Cloud Run, or on HTTP/2 / direct-to-bucket upload). Images are fixed at 10 MB. |
| `MAX_PENDING_PUSH_BYTES` | `5242880` (5 MB) | **Push Confirmation Gate.** Max serialized size of a single held push (`pending_pushes.payload_blob`). A gated `ctx push` carries its full staged payload so a later confirm applies it byte-for-byte; a payload over this limit is rejected at push time. |
| `PENDING_PUSH_TTL_MS` | `604800000` (7 days) | **Push Confirmation Gate.** Time-to-live for a held push. After this, the push lazily flips to `expired` (reported on poll, and no longer confirmable — a confirm/reject on it returns `409`). |
| `LOGO_URL` | _(unset)_ | Custom logo shown in the UI header + login screen. Must start with `https://`, `http://`, or `data:image/` — other schemes (`file://`, relative, `javascript:`) are rejected with a warning and the bundled icon is used. |
| `PROMPTOWL_TEAMS_ENABLED` | _(unset — off)_ | Lets users who signed in with PromptOwl import their PromptOwl teams as local teams. Off by default; set `true` to enable, or toggle from Settings → Advanced. When off, `GET/POST /teams/promptowl` return `404` and the PromptOwl Teams panel is hidden. Independent of `PROMPTOWL_SIGN_IN_GATE`. |
| `TYPE_ARTIFACT_ENABLED` | `true` | Set `false` to disable creation of **artifact** nodes server-wide (existing artifact nodes stay readable — never data loss). Runnable types (agent/skill/tool) are gated by `FEATURE_WORKFLOW_PLANE`, not here. Also editable from Settings (`/admin/settings`). |
| `TYPE_TABLE_ENABLED` | `true` | Same as above for **table** nodes. |
| `FEATURE_WORKFLOW_PLANE` | _(unset — off)_ | Enables the workflow plane: typed edges, edge-type registry, governed runs. Optional feature; also toggleable from Settings. |
| `FEATURE_SUBAGENT_RUNS` | _(unset — off)_ | Lets runs spawn nested sub-agent runs (recursion). Gated separately from the plane; requires `FEATURE_WORKFLOW_PLANE`. Also toggleable from Settings → Advanced (turning the plane off forces this off too). Opens a recursion surface — enable only after reviewing the depth/fan-out caps. |
| `SUBAGENT_MAX_DEPTH` | `8` | Max sub-agent nesting depth (clamped 1..32) — bounds the call tree's HEIGHT so it stays finite/haltable. |
| `SUBAGENT_MAX_CHILDREN` | `16` | Max direct children a single run may spawn (clamped 1..128) — bounds the call tree's WIDTH. Together with `SUBAGENT_MAX_DEPTH` this caps total tree size so a runner can't fork-bomb the DB. |
| `RUN_MAX_STEPS` | `10000` | Max steps a single run may accumulate (clamped 10..100000) — bounds a runaway/hostile runner's step log. |
| `RUN_MAX_CONCURRENT_ROOTS` | `50` | Max concurrently-running root (depth-0) runs per nest (clamped 1..1000). The subagent caps bound a single tree; this bounds how many trees can run at once, so triggers can't flood a nest. |
| `ANTHROPIC_API_KEY` | _(unset)_ | Server-wide default runner key for workflow-plane agent runs. Never returned by the API — the health endpoint reports presence only, and Settings shows a masked tail. |
| `SLACK_WEBHOOK_URL` | _(unset — connector off)_ | Slack incoming-webhook URL for governance-event notifications (review submitted/approved/rejected, collaborator added). `https://` only — the URL embeds a secret. Also editable from Settings in the UI. |
| `MSTEAMS_WEBHOOK_URL` | _(unset — connector off)_ | Microsoft Teams incoming-webhook URL for the same governance events, posted as Adaptive Cards. `https://` only — the URL embeds a secret. Also editable from Settings in the UI. See [Microsoft Teams notifications](#microsoft-teams-notifications). |
| `SMTP_URL` | _(unset — connector off)_ | SMTP connection URL for email notifications (`smtp://` or `smtps://`, credentials inline). Requires `NOTIFY_EMAIL_FROM` and `NOTIFY_EMAIL_TO`. Also editable from Settings. |
| `NOTIFY_EMAIL_FROM` | _(unset)_ | From address for notification emails. |
| `NOTIFY_EMAIL_TO` | _(unset)_ | Comma-separated recipients for notification emails. |
| `NOTIFY_DEBOUNCE_MS` | `15000` | Per-nest buffer window before notifications flush; bursts collapse into one digest message. |

---

## Microsoft Teams notifications

Set `MSTEAMS_WEBHOOK_URL` (or paste the URL into **Settings → Notifications →
Microsoft Teams notifications**) and the server posts the same governance
events the Slack connector covers — review requested / approved / rejected,
collaborator added, plus per-nest burst digests — to one Teams channel as
[Adaptive Cards](https://adaptivecards.io/). Leave it empty to turn the
connector off. Delivery is fire-and-forget with a short timeout: a Teams
outage or a bad URL never slows down or fails the action that triggered the
message.

> Naming note: the setting is `msteams_webhook_url` / `MSTEAMS_WEBHOOK_URL`
> because "teams" in this product means user groups (the `/teams` API), not
> Microsoft Teams.

### Create the incoming webhook in a Teams channel

Microsoft retired the classic Office 365 "Incoming Webhook" connectors;
webhooks are now created with the **Workflows** (Power Automate) app:

1. In Microsoft Teams, open the channel that should receive notifications,
   click **⋯ (More options) → Workflows**.
2. Pick the template **"Post to a channel when a webhook request is
   received"** (searching for "webhook" finds it), sign in if prompted, and
   confirm the team + channel.
3. Create the flow and **copy the HTTP POST URL** it shows (a
   `https://….logic.azure.com/…` or `https://….powerplatform.com/…` address).
4. Paste that URL into **Settings → Notifications → Microsoft Teams
   notifications** (or set `MSTEAMS_WEBHOOK_URL`).
5. Save, then click **Send test** on the card to post a test message and
   confirm the channel receives it. (The button tests the *saved* URL — save
   first, then test. The Slack card has the same button.)

If your tenant still has a legacy Office 365 connector webhook, it is expected
to accept the same payload envelope (legacy connectors documented support for
Adaptive Card attachments, though we have not verified one end-to-end — the
card's plain-text `fallbackText` is the safety net) — but create new hooks via
Workflows.

The URL embeds a secret — anyone holding it can post to the channel, so treat
it like a password (it is why the setting requires `https://`). The server
sends the standard envelope Workflows expects:
`{"type": "message", "attachments": [{"contentType":
"application/vnd.microsoft.card.adaptive", "content": {…card…}}]}` with a
plain-text `fallbackText` for clients that cannot render cards.

Per-nest connector rows post the same Adaptive Card format to a nest-specific
webhook, with per-event filtering: `POST /nests/:id/connectors` with a JSON
body like `{"channel": "teams", "url": "https://…", "events":
["review_requested", "review_rejected"]}` (`events` may also be `["*"]`; the
`url` may be an `env:KEY` reference into the nest's env store). Manage rows
with `GET`/`PATCH`/`DELETE` on the same path.

---

## Single sign-on (OIDC)

Generic OpenID Connect sign-in against any spec-compliant identity provider —
Microsoft Entra ID and Google are the first-class presets in **Settings →
Single sign-on**. The server runs a standard authorization-code flow with PKCE:
`GET /auth/oidc/login` redirects to your IdP, `GET /auth/oidc/callback` verifies
the returned ID token (issuer, audience, nonce, signature against the issuer's
JWKS) and starts a normal browser session. Users are looked up by email;
unknown emails are created automatically when `OIDC_AUTO_PROVISION` is on.

All seven `OIDC_*` values are also editable at runtime from **Settings → Single
sign-on** (superadmin only) — no restart needed. The Settings page shows the
exact **redirect URI** to register with your IdP:

```
<PUBLIC_BASE_URL or server origin>/auth/oidc/callback
```

Set `PUBLIC_BASE_URL` when the server sits behind a reverse proxy so the
redirect URI is derived from the canonical address rather than the incoming
Host header.

### Connect Microsoft Entra ID

1. **Register an app.** Entra admin center → *Identity → Applications → App
   registrations → New registration*. Name it (e.g. "ContextNest"), leave the
   account type at *Accounts in this organizational directory only*.
2. **Add the redirect URI.** In the registration: *Authentication → Add a
   platform → Web*, and paste the redirect URI shown on the ContextNest
   Settings page (`https://<your-server>/auth/oidc/callback`).
3. **Create a client secret.** *Certificates & secrets → New client secret*.
   Copy the secret **value** (not the ID) immediately — it's shown once.
4. **Collect the IDs.** On the app's *Overview* page copy the **Application
   (client) ID** and the **Directory (tenant) ID**.
5. **Fill in ContextNest.** Settings → Single sign-on: click **Microsoft Entra
   ID**, paste the tenant ID when prompted (issuer becomes
   `https://login.microsoftonline.com/<tenant>/v2.0`), then paste the client
   ID and the secret value. Optionally restrict **Allowed email domains** to
   your org's domain. Save, then flip the toggle **On** and save again (or in
   the same save).
6. **Test.** Open the login page in a private window — a **Sign in with
   Microsoft** button appears and round-trips through Entra. Entra accounts
   without an `email` claim fall back to `preferred_username` (the UPN).

For **Google**: create an OAuth client ID (type *Web application*) in the
Google Cloud console, add the same redirect URI under *Authorized redirect
URIs*, and use the **Google** preset (issuer `https://accounts.google.com`)
with that client ID/secret.

### Department auto-tagging

With `OIDC_DEPARTMENT_TAGGING` on (Settings → Single sign-on → **Department
auto-tagging**), every document a user **creates** is tagged
`dept:<slugified-department>` from their directory department — e.g. a user in
*Customer Success* creates docs tagged `dept:customer-success`. Create-only:
edits never add or change the tag, and existing documents are never
retro-tagged. Users without a department (password accounts, or an IdP that
doesn't emit the claim) create untagged documents — never an error.

The department is read from the **`department` claim** in the OIDC ID token
and stored on the user at every SSO login: a new value updates it, an absent
claim clears it, so directory moves propagate on the user's next sign-in.

Microsoft Entra ID does **not** emit the claim by default — add it to the app
registration: *Token configuration → Add optional claim → Token type: **ID**
→ select **department** → Add* (grant the suggested Microsoft Graph
permission if prompted), and make sure the users' *Department* field is
populated in Entra. Other IdPs work too as long as they emit a string
`department` claim in the ID token (e.g. a Keycloak user-attribute mapper).

> **Privacy note:** the `dept:<slug>` tag becomes part of the document's
> visible metadata — anyone who can read the document (collaborators, shared
> nests, public nests) can see the creator's directory department. That's
> PII-adjacent organizational data; consider this before enabling on servers
> where documents are shared beyond the creator's own team or made public.

### Revoking access (offboarding)

Disabling a user **at the IdP** only blocks *new* sign-ins — an existing
ContextNest session stays valid until it expires (30 days). To cut access
immediately, **remove the user in ContextNest** (Settings → users): that wipes
all of their active sessions at once. Real offboarding is therefore two steps —
disable at the IdP *and* remove in ContextNest — with the ContextNest step being
the one that ends live sessions.

When a user signs themselves out, ContextNest performs an **RP-initiated
logout**: if the IdP advertises an `end_session_endpoint` (Entra, Okta,
Keycloak do; Google does not), the browser is bounced through it so the IdP
session ends too and the next "Sign in with SSO" click doesn't silently
re-authenticate. Where the IdP has no logout endpoint, the local session is
cleared and the user lands back on the login page (the IdP session persists —
that's the IdP's own timeout to manage).

### Email-verification trust assumption

An ID token whose `email_verified` claim is **explicitly `false`** is refused
(`?sso_error=email_not_verified`). When the claim is **absent**, the server
trusts the email claim — Microsoft Entra ID v2 tokens frequently omit it, and
both Entra and Google guarantee address ownership, so refusing on absence
would break the primary providers. This is a deliberate trust assumption:
**when your IdP allows unverified self-registered emails (e.g. an open
Keycloak realm), configure `oidc_allowed_domains` and disable self-registration
at the IdP** — otherwise anyone able to assert an arbitrary email at your IdP
could sign in as the matching local account.

Sign-in failures bounce back to the app as `/?sso_error=<code>` and surface as
a toast; codes: `disabled`, `not_configured`, `discovery_failed`,
`provider_error`, `state_mismatch`, `exchange_failed`, `invalid_token`,
`email_not_verified`, `domain_not_allowed`, `not_invited`, `rate_limited`,
`service_error`.

---

## Agent SSO (token exchange)

`POST /auth/token-exchange` lets an external agent, acting for a user your IdP
(Microsoft Entra / Google) has **already** authenticated, exchange that IdP's ID
token for a short-lived MCP bearer — no second login, no static API key.
RFC 8693-shaped. **Off by default and security-critical**: it trusts a token
minted elsewhere and hands back access, so read this section before enabling it.

Configure it with the `SSO_TOKEN_EXCHANGE_ENABLED` / `MCP_SIGNING_SECRET` /
`MS_*` / `GOOGLE_*` vars above, or from **Settings → Single sign-on → Agent SSO**
(superadmin). It reuses `OIDC_ALLOWED_DOMAINS` and `OIDC_AUTO_PROVISION` — the
same who-may-sign-in policy as browser login.

**Who this is for — and who it is not.** The minted bearer is short-lived by
design (`MCP_TOKEN_TTL_SECONDS`, default 300s, hard ceiling 3600s), and there is
no refresh token: renewal means calling `POST /auth/token-exchange` again with
the IdP token. So this fits a **programmatic** client — an agent runtime, a
backend service, a desktop app that already did an MSAL/Google sign-in — that
can re-exchange in code before a session or on a `401`, with no human involved.

It does **not** fit a client whose credential is typed once into a config file
(Claude Desktop, Cursor, any `mcpServers` JSON block): nothing here rewrites that
file, and the ceiling is an hour, so the connection would break repeatedly. Those
clients keep using a long-lived API key (`cnst_…`) — this endpoint is additive
and changes nothing about API-key or browser sign-in.

**What is verified** on the inbound `subject_token`, before anything is minted:

- **signature** against the provider's JWKS, algorithm pinned to `RS256`
- **issuer** — exact per provider (the tenant-scoped Entra issuer, or Google's)
- **audience** — your configured client id, so a token minted for *another*
  application cannot be replayed here
- **expiry** (30s clock tolerance)
- the same `email_verified` + domain-allowlist policy as browser login
  (see [Email-verification trust assumption](#email-verification-trust-assumption))

**Trust model / documented tradeoff.** Unlike the browser flow there is no
session to bind, so the OIDC `nonce` binding is intentionally dropped; trust
rests on signature + issuer + audience + expiry + `email_verified`. That is the
standard token-exchange model, and it is why the audience check (and a
correctly scoped IdP app registration) carries the weight here.

**Provisioning fails closed.** JIT-provisioning from a token minted elsewhere is
only allowed when `OIDC_ALLOWED_DOMAINS` bounds who may self-create. With
auto-provision on and an empty allowlist, every exchange for an unknown email is
refused with `no_account`, and the Settings page refuses to save that
combination — otherwise any account at a public IdP (Google = the whole
internet) could sign itself up and mint a bearer.

**Entra caveat (`preferred_username`).** Entra v2 tokens often omit `email` and
carry the address in `preferred_username`, which is a directory attribute — in a
tenant where guests or external identities can set their own mail attribute, a
token can assert an address that matches an existing local account. Pinning
`MS_TENANT_ID` to your own directory bounds that to identities your tenant
admits; treat inviting a guest as granting whatever that email address owns here.

**Rate limiting.** The per-IP cap on this endpoint reads the client IP from
`X-Forwarded-For`, so it is only a real cap behind a proxy that overwrites that
header. Deploy accordingly — an internet-facing server with a pass-through
header can be sprayed from a single host.

**Scope.** The minted bearer carries `scope: "mcp"`. That is a *route*
allowlist, not a reduced permission set: it reaches `/index`, `/mcp`, and the
ticket-eligible `/nests/:id/*` routes (including MCP write tools) with the
user's full stewardship rights. Keep `MCP_TOKEN_TTL_SECONDS` short.

**Revocation.** Turning the master flag off stops *minting* but does not revoke
bearers already issued — they remain valid until they expire (≤ 1h). Clear
`MCP_SIGNING_SECRET` to invalidate every outstanding bearer at once.

Error codes returned by the endpoint: `disabled` (404), `rate_limited` (429),
`bad_request`, `provider_disabled`, `provider_misconfigured` (400),
`invalid_subject_token` (401), `email_not_verified`, `domain_not_allowed`,
`no_account` (403), `server_error` (500).

---

## Database backends

The governance/auth metadata (users, sessions, nests registry, stewards, reviews,
versions index, comments, telemetry) is stored in a relational database. Two
backends are supported:

- **SQLite (default).** A single file at `DATABASE_PATH`. Zero-config, ideal for
  single-box and local deployments. Nothing changes for existing installs.
- **PostgreSQL / Cloud SQL.** For deployments where local disk isn't durable
  (e.g. Google Cloud Run, where the container filesystem is ephemeral). Selected
  by setting `DB_DRIVER=postgres`, `DATABASE_URL`, or `CLOUD_SQL_CONNECTION_NAME`.

On first connect the server creates its schema automatically (idempotent) — no
manual migration step. There is no built-in SQLite→Postgres data migration; a new
Postgres backend starts empty.

### First-boot upgrade passes

Some upgrades carry a one-shot data pass that runs at startup, before the server
accepts requests, and records itself in `schema_migrations` so it never repeats.
Two exist today: the `node_versions` backfill from `history.yaml`, and the
version-chain repair added in 1.13 (re-anchors documents whose version chain was
grafted by an older import, and moves inline patches into `v{N}.diff` files).

Both walk every document in every nest, so on a large vault the **first** boot
after upgrading can take noticeably longer than usual — reads of the on-disk
vault, not database work, so an install on network/FUSE storage feels it most.
Every subsequent boot skips the pass entirely. Progress and a per-pass summary
are printed to the server log.

> ⚠️ **Cloud Run durability — read this.** Cloud SQL persists only the *metadata
> database*. The actual **document content and version history** live on the
> filesystem under `$DATA_ROOT/nests/`, which on Cloud Run is **ephemeral** and is
> lost when an instance is recycled. Using Cloud SQL alone does **not** make a
> Cloud Run deployment fully durable. You must also put `$DATA_ROOT` on persistent,
> shared storage — e.g. mount a GCS bucket via Cloud Storage FUSE, or use a
> persistent volume — otherwise documents will disappear on redeploy/scale-in.

### Runtime settings persistence

Settings you change at runtime — everything on the **Settings page** (`/admin/settings`:
sign-in gate, logo, base URL, upload limit, feature flags, OIDC SSO, Slack/Teams/SMTP connectors)
plus the **installed license key** — are stored in the database (`server_settings`
table), **not** in a `.env` file. This is deliberate: on Cloud Run the container
filesystem is ephemeral, so a file-based value was wiped by every rebuild, and each
horizontally-scaled instance had its own filesystem, so a change on one never
reached the others. The database (Cloud SQL in production) is durable **and** shared,
so a UI change persists across rebuilds and is seen by every instance. Rows are
loaded into the process environment at boot.

**Precedence between the deploy environment and a UI change.** Each stored row
remembers the deploy-env value in effect when it was written. At boot:

- If the deploy env value for that key is **unchanged**, the stored UI change wins
  (your Settings-page edit survives an identical rebuild).
- If the deploy env value **changed** (you redeployed with a new value for that
  variable), the deploy env wins and the stored row is re-synced to it.

So you can always override any setting from the deploy config, while UI edits made
to keys you don't set in the environment stay put. Clearing a setting in the UI
writes a tombstone, so a value you removed is not resurrected from the environment
on the next boot.

### Cloud Run + Cloud SQL (PostgreSQL)

Attach the Cloud SQL instance to the service (`--add-cloudsql-instances`) so the
Auth Proxy unix socket appears at `/cloudsql/<connection-name>`, then:

```bash
DB_DRIVER=postgres \
CLOUD_SQL_CONNECTION_NAME=my-project:us-central1:contextnest \
DB_USER=contextnest \
DB_PASSWORD=*** \
DB_NAME=contextnest \
DATA_ROOT=/mnt/vault \   # mount GCS/persistent storage here — see warning above
PROMPTOWL_KEY=pk_... \
node dist/index.js
```

Or with a plain TCP connection string (e.g. the Cloud SQL Proxy running on
localhost, or a private IP):

```bash
DATABASE_URL=postgres://contextnest:***@127.0.0.1:5432/contextnest \
DB_DRIVER=postgres \
DATA_ROOT=/mnt/vault \
npm start
```

## Typical deployments

### Local dev / single user

```bash
AUTH_MODE=open DATA_ROOT=./my-data npm run dev
```

Or the default dev mode if `npm run dev` already sets `AUTH_MODE=open` in your scripts.

### Team / multi-user behind a reverse proxy

```bash
AUTH_MODE=key \
CORS_ORIGINS="https://team.example.com,https://admin.example.com" \
DATA_ROOT=/var/lib/contextnest \
PROMPTOWL_KEY=pk_... \
npm start
```

Terminate TLS at the proxy, forward `X-Forwarded-For` and `X-Real-IP` headers (the rate limiter reads them), and bind the server to `127.0.0.1` so only the proxy can reach it.

### Hosted / commercial SaaS

Same as team, plus:
- Run N instances behind a load balancer. SQLite + a shared filesystem is not a great long-term story for the metadata DB when scaling beyond one box — switch to the **PostgreSQL / Cloud SQL** backend (see [Database backends](#database-backends)) so all instances share one consistent database. The on-disk nest vault under `$DATA_ROOT/nests/` still needs durable shared storage.
- Set `TELEMETRY_ENABLED=true` and a valid `PROMPTOWL_KEY` so usage rolls up to PromptOwl.
- Rotate keys regularly via `DELETE /auth/keys/:id` + `POST /auth/keys`.

---

## access.yaml (optional, open + key mode)

Drop an `access.yaml` at `$DATA_ROOT/access.yaml` to add a server-level ABAC layer — useful even in key mode for super-admins and group-based defaults.

```yaml
mode: restricted
allowed_users:
  - "*.acme.com"                # email wildcard — anyone @acme.com
  - "partner@vendor.com"         # exact match
super_admins:
  - "ceo@acme.com"               # admin on every nest: visibility, collaborators, stewards (not owner-only delete/transfer)
groups:
  engineering:
    default_permission: write
    members:
      - "*.eng.acme.com"
  viewers:
    default_permission: read
    members:
      - "*.contractor.acme.com"
```

See `STEWARDSHIP.md` for how super-admins and groups interact with per-nest stewardship.

---

## Reload

Changing env vars requires a restart — the server reads them at boot. `tsx watch` in dev will pick up code changes automatically but not env changes.
