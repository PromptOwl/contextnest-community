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
| `PUBLIC_BASE_URL` | `""` | This server's canonical external URL (e.g. `https://community.promptowl.ai`). Two uses. (1) Checked against the SSO ticket's `aud` claim so a ticket minted for this server can't be replayed against another — only when `OFFICIAL_COMMUNITY_SSO_SECRET` is set; when unset, the audience check is skipped. (2) **Set this whenever `OIDC_ENABLED=true`.** It's the base for the OIDC `redirect_uri` sent to your IdP and replayed at token exchange. Unset, that URI is derived from the incoming request's `Host` header — fine when your proxy overwrites `Host` with a trusted value, but a proxy that passes an attacker-supplied `Host` through would feed it straight into the redirect URI. Setting this pins the value regardless of what the proxy forwards. (Your IdP's own redirect-URI allowlist is a second line of defence, not a substitute.) |
| `OIDC_ENABLED` | `false` | Turn on generic OIDC single sign-on (`GET /auth/oidc/login` / `GET /auth/oidc/callback`). Requires `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` — the login-page button only appears once all three are set. Also editable from Settings → Single sign-on. See [Single sign-on (OIDC)](#single-sign-on-oidc). |
| `OIDC_ISSUER` | `""` | OIDC issuer URL, e.g. `https://login.microsoftonline.com/<tenant>/v2.0` (Microsoft Entra ID) or `https://accounts.google.com` (Google). **`https://` only** — a non-https value is rejected with a warning and SSO stays off. Must serve `<issuer>/.well-known/openid-configuration`. |
| `OIDC_CLIENT_ID` | `""` | Application (client) ID from your IdP app registration. |
| `OIDC_CLIENT_SECRET` | `""` | Client secret from your IdP app registration. Write-only on the Settings API — `GET /admin/settings` reports only `oidc_client_secret_set: true/false`, never the value. |
| `OIDC_ALLOWED_DOMAINS` | `""` (any) | Comma-separated email-domain allowlist, e.g. `acme.com, contractors.acme.com`. When set, only accounts whose asserted email is on a listed domain may sign in (others bounce with `domain_not_allowed`). Empty allows any domain the IdP asserts. |
| `OIDC_AUTO_PROVISION` | `true` | Create a user automatically on first successful OIDC sign-in (display name from the `name` claim). Set `false` to allow only pre-existing (invited/registered) users — unknown emails bounce with `not_invited`. |
| `ENV_FILE_PATH` | `$DATA_ROOT/.env` | Path to an optional `.env` file the server reads at boot (in addition to `$cwd/.env`). **No longer used for persistence** — the License Setup Page and Settings page now write to the database, not this file (see [Runtime settings persistence](#runtime-settings-persistence)). Kept for operators who bootstrap config from a mounted `.env`. |
| `TELEMETRY_ENABLED` | `"true"` (set to `"false"` to disable) | Batched, anonymized usage events sent to PromptOwl. Off disables the loop entirely. |
| `TELEMETRY_INTERVAL_MS` | `3600000` (1 hour) | How often buffered telemetry is flushed to PromptOwl. |
| `TRACE_RETENTION_DAYS` | `14` | Activity-trace retention window in days (the `api_events` rows behind `GET /admin/trace` and `GET /nests/:id/trace`). Rows older than this are pruned opportunistically (every ~500 inserts). `0` = keep forever (pruning is skipped entirely). Capped at `3650`; invalid/negative values fall back to `14`. Also editable from Settings → Advanced. |
| `CORS_ORIGINS` | `*` in open mode; `http://localhost:5173,http://localhost:3838` in key mode | Comma-separated allowlist. Set to `*` to allow any origin (**only** safe in open mode — in key mode with Bearer tokens this enables CSRF). |
| `MAX_BODY_BYTES` | `10485760` (10 MB) | Reject requests whose `Content-Length` exceeds this. Prevents giant-payload DoS. |
| `LOGO_URL` | _(unset)_ | Custom logo shown in the UI header + login screen. Must start with `https://`, `http://`, or `data:image/` — other schemes (`file://`, relative, `javascript:`) are rejected with a warning and the bundled icon is used. |
| `FEATURE_WORKFLOW_PLANE` | _(unset — off)_ | Enables the workflow plane: typed edges, edge-type registry, governed runs. Optional feature; also toggleable from Settings. |
| `FEATURE_SUBAGENT_RUNS` | _(unset — off)_ | Lets runs spawn nested sub-agent runs (recursion). Gated separately from the plane; requires `FEATURE_WORKFLOW_PLANE`. Also toggleable from Settings → Advanced (turning the plane off forces this off too). Opens a recursion surface — enable only after reviewing the depth/fan-out caps. |
| `SUBAGENT_MAX_DEPTH` | `8` | Max sub-agent nesting depth (clamped 1..32) — bounds the call tree's HEIGHT so it stays finite/haltable. |
| `SUBAGENT_MAX_CHILDREN` | `16` | Max direct children a single run may spawn (clamped 1..128) — bounds the call tree's WIDTH. Together with `SUBAGENT_MAX_DEPTH` this caps total tree size so a runner can't fork-bomb the DB. |
| `RUN_MAX_STEPS` | `10000` | Max steps a single run may accumulate (clamped 10..100000) — bounds a runaway/hostile runner's step log. |
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

All six `OIDC_*` values are also editable at runtime from **Settings → Single
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
