# Configuration

All server configuration is driven by environment variables. Set them in your shell, in a `.env` file, in a Docker image, or via your process manager — however you deploy the rest of your stack.

## Auth modes

The server supports two authentication modes. You pick one per instance with `AUTH_MODE`.

### `AUTH_MODE=key` (default)

Every request requires an `Authorization: Bearer cnst_...` header. Use this for any multi-user or internet-facing deployment.

- Users register via `POST /auth/register` (email + password) or log in with PromptOwl via `POST /auth/device` → `POST /auth/promptowl`.
- API keys are per-user (`cnst_<64-hex>`) and can be scoped to a single nest for service-account use. A nest-scoped key reaches that nest (its REST routes and `/nests/<id>/mcp`), the server `/mcp` and `/index` filtered to it, and `GET /nests` / `/search` / `/stats` narrowed to it — and nothing else: other nests, `/auth/keys*` (so it can't mint itself a wider key), `/admin/*`, teammates, teams, people and `/me/*` answer `403` with `code: "nest_scoped_key"`, even when the key's owner is a server admin. Mint one on the API keys page (scope picker) or from a nest's Connect dialog ("Create a key for this nest only"). See `API.md → Nest-scoped API keys`.
- Rate-limited login / register / device-auth endpoints (sliding window, per IP + per email).
- First PromptOwl-authenticated user becomes the server admin (atomic claim). Admin can invite teammates at `POST /auth/invite`.

Clients include the token on every request:

```bash
curl -H 'Authorization: Bearer cnst_<your-token>' http://your-server/nests
```

### `AUTH_MODE=open`

No authentication required. Every request is attributed to the anonymous admin user (`00000000-...`). Everyone effectively owns every anon-created nest.

**Use this only when:**
- You're running locally for yourself (`HOST=127.0.0.1`), or
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
| `HOST` | _(unset — every interface)_ | Interface to listen on. `127.0.0.1` accepts only local connections — use it when a reverse proxy on the same machine is the only thing that should reach the server, or for `AUTH_MODE=open`. |
| `TRUSTED_PROXIES` | _(unset — trust every peer)_ | Who may set `X-Forwarded-For`, `X-Real-IP` and `X-Forwarded-Proto`: comma-separated IPs, CIDRs (`10.0.0.0/8`, `2001:db8::/32`) and/or the keywords `loopback` and `private`. When set, those headers are believed only from a matching TCP peer; the client IP is the nearest hop in the `X-Forwarded-For` chain that isn't a listed proxy. Unset keeps the old behaviour (believe any peer), which lets a client that reaches the server directly spoof its IP — dodging per-IP rate limits — and its scheme. Startup warns while it's unset (except on Cloud Run). A malformed value stops the server from starting. See [Reverse proxies](#reverse-proxies). |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | _(unset — direct egress)_ | Corporate egress proxy for outbound HTTP(S). Must be set in the **process environment** (not `.env`) and needs `NODE_USE_ENV_PROXY=1`. See [Corporate egress proxy](#corporate-egress-proxy). |
| `NODE_USE_ENV_PROXY` | `1` in the Docker image, unset otherwise | Node's switch for honouring the proxy variables above (Node ≥ 22.21 or ≥ 24.5). A no-op when no proxy is set. Outside Docker, export it yourself or start with `node --use-env-proxy`. |
| `NODE_EXTRA_CA_CERTS` | _(unset)_ | Path to a PEM bundle of extra root CAs — needed when a TLS-inspecting proxy re-signs outbound traffic with a corporate CA. Read by Node at process start only, so set it in the process environment. Startup logs the path, or warns if the file is missing or the value came from `.env`. |
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
| `PROMPTOWL_KEY` | `""` | Your PromptOwl Community License key (`pk_...`). Unlicensed instances still run and serve reads, but every write returns `503` until a valid key is installed. Can also be set via the browser License Setup Page, which persists it to the database (`server_settings` table) so it survives a rebuild and reaches every instance — see [Runtime settings persistence](#runtime-settings-persistence). Setting it here in the deploy environment takes precedence on the next boot. The license is re-checked with PromptOwl every 60s. Each check reports the server's user and nest counts, version and `PUBLIC_BASE_URL`, independently of `TELEMETRY_ENABLED` and never including content. See [API.md → License](API.md#license). |
| `PROMPTOWL_SIGN_IN_GATE` | `open` | Restrict "Sign in with PromptOwl". `open` = anyone may; `admin-only` = only the license owner (admin) may, everyone else uses email/password (admin opens the login page with `?admin=1`); `disabled` = nobody may. Enforced server-side at `POST /auth/promptowl` and surfaced on the health endpoint. Unset or unknown values take the default. With SSO on, everyone your identity provider vouches for already gets in through SSO, so password self-registration is closed by default; an explicit `open` still works but logs a startup warning and shows one on the Settings page, and while `OIDC_ALLOWED_DOMAINS` is set, password self-registration is limited to those domains too. |
| `MANUAL_SIGN_IN` | `open`; `invite-only` when SSO (OIDC) is on and configured | Email + password sign-in mode. `open` = anyone may log in and self-register a new account; `invite-only` = existing/invited users may log in but brand-new self-registration returns `403` (the admin provisions accounts via invite/share/steward and shares the password — there is no self-service "set password", which would be account takeover without email verification); `disabled` = no email/password sign-in at all (`POST /auth/login` and `POST /auth/register` return `403`). Independent of `PROMPTOWL_SIGN_IN_GATE`, so the two methods are controlled separately (e.g. `invite-only` manual + `admin-only` PromptOwl). Also settable from Server settings → Basic. The server refuses `disabled` while PromptOwl sign-in is also `disabled`, unless SSO (OIDC) is on and fully configured (that would leave no way to log in — see [Making SSO the only way in](#making-sso-the-only-way-in)). Unset or unknown values take the default. With SSO on, everyone your identity provider vouches for already gets in through SSO, so password self-registration is closed by default; an explicit `open` still works but logs a startup warning and shows one on the Settings page, and while `OIDC_ALLOWED_DOMAINS` is set, password self-registration is limited to those domains too. |
| `OFFICIAL_COMMUNITY_SSO_SECRET` | `""` | **Legacy — official deployment only, leave unset on self-hosted.** Shared HMAC secret enabling the one-click "Open Community" SSO auto-login from PromptOwl. Must exactly match the same-named var on PromptOwl. Superseded by the DB-backed **Server settings → Community sites** list (`/admin/community-sites`), which supports multiple official sites each with their own name/url/secret/active flag — this env var still works as an implicit extra site for backward compatibility. When no site is configured (env var unset and no DB rows), `GET /auth/sso` returns `404` and the feature is disabled; self-hosted users keep using the manual device-code flow. See `API.md → Community sites`. |
| `PUBLIC_BASE_URL` | `""` | This server's canonical external URL (e.g. `https://community.promptowl.ai`). Two uses. (1) Checked against the SSO ticket's `aud` claim so a ticket minted for this server can't be replayed against another — whenever a ticket-signing secret is set (`OFFICIAL_COMMUNITY_SSO_SECRET` on the official deployment, `MCP_SIGNING_SECRET` on a self-hosted one); with neither set no ticket verifies at all, so the audience check is moot. (2) **Set this whenever `OIDC_ENABLED=true`.** It's the base for the OIDC `redirect_uri` sent to your IdP and replayed at token exchange. Unset, that URI is derived from the incoming request's `Host` header — fine when your proxy overwrites `Host` with a trusted value, but a proxy that passes an attacker-supplied `Host` through would feed it straight into the redirect URI. Setting this pins the value regardless of what the proxy forwards. (Your IdP's own redirect-URI allowlist is a second line of defence, not a substitute.) (3) **Set this wherever email- or invite-gated publish links are used.** The magic link mailed by `POST /p/:slug/gate` is built from it; unset, it falls back to the request origin, so a proxy forwarding an attacker-supplied `Host` would send the recipient a one-time access token pointing at the attacker's domain — the classic reset-link poisoning. (4) **Set this wherever `POST /nests/:id/context` citations reach users.** The `url` on each node and the `_source:` line in each context block are built from it; unset, they fall back to the request origin, so a proxy forwarding an untrusted `Host` would put an attacker-influenced URL in front of both the model and the reader as a trustworthy citation. (5) It is rendered into the copy-paste setup snippets on **Server settings → Connecting agents** — a `bash` block and quoted strings in `config.toml` / `config.yaml` / `mcp.json`. Because those are pasted verbatim into other people's terminals, `PATCH /admin/settings` refuses a value that is not a plain `http(s)` URL, or that contains whitespace, quotes or shell characters (`" ' ` \ $ ; | & < > ( ) { }`). A value stored before that check is not rewritten, so re-save it if the panel shows it oddly. |
| `DOCS_SITES` | `""` | Operator-set custom domains for public docs sites, as `host=nestId` pairs separated by commas (e.g. `docs.contextnest.ai=ad8fe978-…`). Owners can also claim a domain themselves in the nest's **Public site** settings (verified by DNS TXT); this variable is for domains you manage centrally and takes precedence. The domain must reach this server with TLS terminated in front of it; that nest's site is then served at the domain's root and `/d/<key>/…` `301`s there. The nest must still be public with Reader Mode on — otherwise the domain answers `404`. Every request on a listed host is the read-only docs site, so never list the server's own host. See [API.md → Public docs site](API.md). |
| `SITE_DOMAIN_CHECK_TOKEN` | `""` | Optional shared secret for `GET /site-domain-check`. When set, the endpoint answers only `?domain=…&token=<value>` and returns `403` otherwise. Put the token in your edge's `ask` URL, so only the edge can ask which domains this server serves. |
| `SITE_DNS_TARGET` | `""` | The DNS name owners point their docs domain at (shown as the CNAME in **Public site** settings) — your load balancer or edge proxy. That edge must terminate TLS for custom domains; to issue certificates on demand only for verified ones, use `GET /site-domain-check?domain=` as its `ask` endpoint (`200` for a verified domain of a live site, `404` otherwise; a port or trailing dot is ignored). The endpoint needs no auth and only reads, and answers are cached for 30 seconds per host. Even so, make it reachable only from your edge (block it at your load balancer, or bind the `ask` to an internal address), so nobody else can probe which domains the server serves. Unset, the settings panel tells owners to ask the server admin. On Google Cloud Run, either add a domain mapping per verified domain or put a load balancer / Caddy with on-demand TLS in front. |
| `MCP_OAUTH_ENABLED` | `false` | Run an OAuth 2.1 authorization server for MCP clients, so an agent (Claude, ChatGPT, Grok, Cursor) signs its user in and is issued a token scoped to **that person** instead of carrying a shared API key. This is what makes per-user nest visibility reachable from vendor-hosted surfaces: the server already gates every nest through `canRead(nestId, userId)`, but a key pasted by several people resolves all of them to the same user. **Requires `PUBLIC_BASE_URL`** — the discovery documents' `resource` must equal the URL the user types into their client, and `/admin/settings` refuses to enable this without one. Off means the surface does not exist: `/.well-known/*` keeps returning 404 and `/mcp` answers unauthenticated callers exactly as before. Superadmin-togglable at runtime (Server settings → Features → Agent OAuth). |
| `OIDC_ENABLED` | `false` | Turn on generic OIDC single sign-on (`GET /auth/oidc/login` / `GET /auth/oidc/callback`). Requires `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` — the login-page button only appears once all three are set. Also editable from **Admin → Server settings → Single sign-on**. See the [Single sign-on (OIDC) admin guide](#single-sign-on-oidc). |
| `OIDC_ISSUER` | `""` | OIDC issuer URL, e.g. `https://login.microsoftonline.com/<tenant>/v2.0` (Microsoft Entra ID) or `https://accounts.google.com` (Google). **`https://` only** — a non-https value is rejected with a warning and SSO stays off. Must serve `<issuer>/.well-known/openid-configuration`. Any issuer other than Google is **Enterprise** (licence feature `sso`): without it, Settings won't switch to one or turn it on, but one already configured keeps signing people in. |
| `OIDC_CLIENT_ID` | `""` | Application (client) ID from your IdP app registration. |
| `OIDC_CLIENT_SECRET` | `""` | Client secret from your IdP app registration. Write-only on the Settings API — `GET /admin/settings` reports only `oidc_client_secret_set: true/false`, never the value. |
| `OIDC_ALLOWED_DOMAINS` | `""` (any) | Comma-separated email-domain allowlist, e.g. `acme.com, contractors.acme.com`. When set, only accounts whose asserted email is on a listed domain may sign in (others bounce with `domain_not_allowed`). Empty allows any domain the IdP asserts. |
| `OIDC_AUTO_PROVISION` | `true` | Create a user automatically on first successful OIDC sign-in (display name from the `name` claim). Set `false` to allow only pre-existing (invited/registered) users — unknown emails bounce with `not_invited`. |
| `NEST_CREATION` | `admins` | Who may create or import nests (REST, folder import, MCP `nest_create`). `admins`: server admins only — the default until a server is on a paid plan; everyone else sees "You don't have access to any nests yet. Ask [admin] to share one." instead of a create button. `everyone`: any signed-in user. Open mode is unaffected. Also editable from **Server settings → Features → Nest creation**. |
| `PEOPLE_SUGGEST_ALL_USERS` | `false` | Widen the add-a-person suggestions (`GET /people/suggest`, behind every "add a person" field) and the `@mention` pickers from *people the caller already shares a nest or team with* to **every registered account on this server**. **Leave this off on a server that hosts more than one organisation** — the PromptOwl-hosted deployment does, and turning it on there would offer one customer's staff another customer's email addresses. On a single-company self-hosted server the whole directory is the useful answer, which is what this is for. Suggestions never gate the invite either way: an address that appears in no list is still valid to type. In the `@` pickers the widening is an invite: a write+ author mentioning someone off the nest adds them as a `read` collaborator before notifying (a read-only author's mention of an outsider reaches nobody). A server admin always sees every account (they administer them). Also editable from **Server settings → Features → People directory**. |
| `SHARED_DEPLOYMENT` | `false` | This server hosts **several unrelated organizations** (the PromptOwl-hosted deployment) rather than one company. A nest's `org` visibility means *every authenticated account on this deployment* — on a single-company self-hosted server that is the organization, so the tier flips in one click; on a shared server it is every customer. With this on: `PATCH /nests/:id/visibility` to `org` requires `acknowledge_public: true` exactly as `public` always does (enforced by the server, not only the UI), and the UI's visibility picker confirms before *Organization* and words both tiers to say who they really reach. Reported on `GET /health` as `shared_deployment`. Also editable from **Server settings → Features → This server hosts several organizations**. **Turning it on guards future changes only** — nests already at `org` stay readable by every account until their admins reconfirm or narrow them. On an already-populated server, audit them first: the dashboard's *Organization* scope lists every one, or `SELECT id, name, user_id FROM nests WHERE visibility = 'org'`. |
| `OIDC_DEPARTMENT_TAGGING` | `false` | Auto-tag newly **created** documents with the creator's directory department: `dept:<slugified-department>` (lowercase, spaces → dashes, e.g. `dept:customer-success`) is appended to the document's tags, deduped against user-supplied tags. Applies on create only — never on update, never retroactively — and a user without a stored department is a silent no-op. The department is captured from the OIDC `department` ID-token claim on every SSO login (a login without the claim clears it, so directory moves propagate), so this is only meaningful when your IdP emits that claim — see [Department auto-tagging](#department-auto-tagging). Also editable from Server settings → Single sign-on. |
| `SSO_TOKEN_EXCHANGE_ENABLED` | `false` | Master switch for `POST /auth/token-exchange` — an external agent exchanges an IdP ID token for a short-lived MCP bearer. Also needs `MCP_SIGNING_SECRET` and at least one provider; otherwise the endpoint returns `404`. Security-critical — see [Agent SSO (token exchange)](#agent-sso-token-exchange). |
| `MCP_SIGNING_SECRET` | `""` | HMAC secret **this** server signs its minted MCP bearers with (distinct from `OFFICIAL_COMMUNITY_SSO_SECRET`, so self-hosted deployments can issue their own). Long random string. `/index` and `/mcp` accept a ticket signed with either secret. Write-only on the Settings API. **Clearing it is the revocation switch** — turning `SSO_TOKEN_EXCHANGE_ENABLED` off stops minting but already-minted bearers stay valid until they expire. |
| `MCP_TOKEN_TTL_SECONDS` | `300` | Lifetime of a minted MCP bearer, clamped to 30–3600. |
| `MS_TOKEN_EXCHANGE_ENABLED` / `MS_CLIENT_ID` / `MS_TENANT_ID` | `false` / `""` / `""` | Microsoft Entra provider. `MS_CLIENT_ID` is the audience an inbound token must carry; `MS_TENANT_ID` must be the directory **GUID** (it builds the required issuer `https://login.microsoftonline.com/<tenant>/v2.0` — `common`/`organizations`/a domain name will not match the discovery document and every exchange returns `provider_misconfigured`). |
| `GOOGLE_TOKEN_EXCHANGE_ENABLED` / `GOOGLE_CLIENT_ID` | `false` / `""` | Google provider. Issuer is fixed (`https://accounts.google.com`); `GOOGLE_CLIENT_ID` is the audience an inbound token must carry. |
| `ENV_FILE_PATH` | `$DATA_ROOT/.env` | Path to an optional `.env` file the server reads at boot (in addition to `$cwd/.env`). **No longer used for persistence** — the License Setup Page and Settings page now write to the database, not this file (see [Runtime settings persistence](#runtime-settings-persistence)). Kept for operators who bootstrap config from a mounted `.env`. |
| `TELEMETRY_ENABLED` | `"true"` (set to `"false"` to disable) | Batched, anonymized usage events sent to PromptOwl. Off disables the loop entirely. |
| `TELEMETRY_INTERVAL_MS` | `3600000` (1 hour) | How often buffered telemetry is flushed to PromptOwl. |
| `POSTHOG_KEY` | `""` | PostHog project API key for product analytics in the UI. Empty = analytics off (the default — a self-hosted install brings its own project). Served to the browser via `/health`, but only while `TELEMETRY_ENABLED` is on, so that switch turns off everything this server sends outward. Also editable from Server settings → Basic. |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingestion host. Set it to your own region or self-hosted PostHog. Also editable from Server settings → Basic. |
| `TRACE_RETENTION_DAYS` | `14` | Activity-trace retention window in days (the `api_events` rows behind `GET /admin/trace` and `GET /nests/:id/trace`). Rows older than this are pruned opportunistically (every ~500 inserts). `0` = keep forever (pruning is skipped entirely). Capped at `3650`; invalid/negative values fall back to `14`. Also editable from Server settings → Basic. |
| `MESSAGE_LOG_RETENTION_DAYS` | `30` | Superadmin message log retention in days (`outbound_messages`, behind `GET /admin/messages`). Every email, Slack/Teams/connector webhook, inbox notification and agent comment the server sends is logged, redacted. Older rows are pruned opportunistically. `0` = keep forever. Capped at `3650`; invalid/negative → `30`. Access-audit rows (`message_log_views`) are kept 365 days regardless. Also editable from Server settings → Basic → Message log. |
| `MESSAGE_LOG_STORE_BODIES` | `true` | Store the (redacted) message body in the message log. `false` keeps metadata only: channel, sender, recipients, subject, delivery status. Also editable from Server settings → Basic → Message log. |
| `RUN_RETENTION_DAYS` | `0` | Agent-run retention in days (the `runs` + `run_steps` rows behind the Run Trace and each metacognition agent's Activity history). Finished runs older than this are pruned hourly; a run still in progress never is. `0` = keep every run (the default — a run is the record of what an agent did, so dropping it is the operator's call). Proposals, comments and access requests an agent made are not pruned; their link to the trace stops resolving. Capped at `3650`; invalid/negative values fall back to `0`. Also editable from Server settings → Basic. |
| `DRIFT_SCAN_INTERVAL_MS` | `30000` (30 s) | How often the drift scanner walks every nest for files edited outside the app (external edits) and stages them as suggestions for review. Set `0` to disable — do this on a GCS FUSE or other network mount, where the walk is slow and costly. Unset, empty or non-numeric falls back to the default. |
| `CONTEXTNEST_AGENT` | `""` | Overrides the `agent` this server derives for caller attribution (`client`, spec §9.4) when a call sends none of its own. Without it the name comes from the MCP `initialize` handshake's `clientInfo.name` when the connection reports one, else the label of the API key the call authenticated with. A caller's own `client.agent` always wins. |
| `CONTEXTNEST_SESSION_ID` | `""` | Same, for `session_id` — otherwise the MCP transport's session id, or an `Mcp-Session-Id` request header when the client sends one. Left absent when nothing reports one: the `/mcp` endpoints are stateless and issue no session, and a placeholder would be indistinguishable from a real id. |
| `CONTEXTNEST_NO_ATTRIBUTION` | `""` | Set to `1` to derive nothing at all. What this server derives lands in an append-only version history, so an operator who does not want an agent's name recorded there permanently needs to say so before the first write. A `client` the caller sent explicitly is still recorded — that is the caller's own record to make. |
| `CORS_ORIGINS` | `*` in open mode; `http://localhost:5173,http://localhost:3838` in key mode | Comma-separated allowlist. Set to `*` to allow any origin (**only** safe in open mode — in key mode with Bearer tokens this enables CSRF). |
| `FRAME_ANCESTORS` | `'self'` | Which origins may embed this server in an iframe, sent as CSP `frame-ancestors`. The default lets nothing but this origin frame the UI, which blocks clickjacking. Deployments that are meant to be embedded list the embedding origin — e.g. the PromptOwl Data Room iframes ContextNest, so that install sets `FRAME_ANCESTORS="https://app.promptowl.ai"`. Comma-separated; `'self'` is always included; `*` allows any site and disables the protection. Note the embedding page must be **same-site** (a sibling subdomain) for the session cookie to survive inside the frame — a genuinely cross-domain embed will render the login page no matter what this is set to. |
| `HEADLESS_KEY_RATE_LIMIT_PER_MIN` | `120` | Requests per minute one headless access key (API.md, "Headless access keys") may make before it gets `429` + `Retry-After`. Per key, in memory, per instance. Clamped to 1–100000. |
| `MAX_BODY_BYTES` | `10485760` (10 MB) | Reject requests whose `Content-Length` exceeds this. Prevents giant-payload DoS. The asset-upload route (`POST /nests/:id/assets`) is exempt up to the video cap below, and the PDF upload route (`POST /nests/:id/nodes/pdf`) up to `PDF_MAX_MB`. |
| `VIDEO_MAX_MB` | `30` | Max size (in MB) of a video uploaded into a doc. Default `30` keeps it under Cloud Run's ~32 MiB HTTP/1 request-body limit, so an oversized video is rejected with a clear message instead of a bare `413` from the platform. Raise only where the deployment can actually accept larger request bodies (not behind Cloud Run, or on HTTP/2 / direct-to-bucket upload). Images are fixed at 10 MB. |
| `MAX_PENDING_PUSH_BYTES` | `5242880` (5 MB) | **Push Confirmation Gate.** Max serialized size of a single held write (`pending_pushes.payload_blob`). A held write carries its full staged payload so a later confirm applies it byte-for-byte; a payload over this limit is rejected at write time. |
| `PENDING_PUSH_TTL_MS` | `604800000` (7 days) | **Push Confirmation Gate.** Time-to-live for a held write. After this, it lazily flips to `expired` (reported on poll, and no longer confirmable — a confirm/reject on it returns `409`). |
| `COMMUNITY_NAME` | _(unset)_ | Display name for this community. One line, 100 characters max. Also editable from Server settings → Basic → Community name. |
| `LOGO_URL` | _(unset)_ | Custom logo shown in the UI header + login screen. Must start with `https://`, `http://`, or `data:image/` — other schemes (`file://`, relative, `javascript:`) are rejected with a warning and the bundled icon is used. Server-wide: a nest's own reader branding (`PATCH /nests/:id/branding`, see API.md) overrides it for that nest's public reader only, and falls back to it when the nest sets no logo. |
| `PROMPTOWL_TEAMS_ENABLED` | _(unset — off)_ | Lets users who signed in with PromptOwl import their PromptOwl teams as local teams. Off by default; set `true` to enable, or toggle from Server settings → Features. When off, `GET/POST /teams/promptowl` return `404` and the PromptOwl Teams panel is hidden. Independent of `PROMPTOWL_SIGN_IN_GATE`. |
| `PDF_MAX_MB` | `25` | Max size (in MB) of a PDF uploaded as a `pdf` document (`POST /nests/:id/nodes/pdf`). A larger file is refused with `413` and nothing is written. Default `25` keeps the request under Cloud Run's ~32 MiB HTTP/1 limit; raise it only where the deployment accepts larger request bodies. The PDF route is exempt from `MAX_BODY_BYTES` up to this cap. |
| `IMPORT_IO_CONCURRENCY` | _(unset — engine default 32)_ | File operations one import (`POST /nests/import`) keeps in flight; publishing runs half as many documents at once. On a network-backed `DATA_ROOT` (Cloud Storage via gcsfuse) every file operation is a round trip, so raising it (e.g. `64`) shortens large imports. Each in-flight file is held in memory, so peak memory grows with it. Also editable from Settings → Basic (1–256). |
| `TYPE_ARTIFACT_ENABLED` | `true` | Set `false` to disable creation of **artifact** nodes server-wide (existing artifact nodes stay readable — never data loss). Runnable types (agent/skill/tool) are gated by `FEATURE_WORKFLOW_PLANE`, not here. Also editable from Settings (`/admin/settings`). |
| `TYPE_TABLE_ENABLED` | `true` | Same as above for **table** nodes. |
| `HOOTIE_ENABLED` | _(unset — off)_ | Hootie in the nest — the assistant side panel on every page of the UI (opened from a tab on the right edge) and its `POST /nests/:id/chat` route. **Off by default since 1.28**: set `true`, or turn it on from Settings → General (a UI choice beats the deploy env, either way). Off → the edge tab disappears and the route answers `404`. Answering needs `ANTHROPIC_API_KEY`; without one the feature stays on but the panel explains what's missing and the route answers `503`. Questions are budgeted per user across all nests (30 per 5 minutes); in `AUTH_MODE=open` every caller is the one anonymous user, so the budget is shared by everyone on that server. |
| `HOOTIE_NAME` | _(unset — "Hootie")_ | **Enterprise** (licence feature `hootie_branding`, included with Enterprise; PromptOwl can also grant or revoke it per licence). The assistant's name, shown on the edge tab, the panel header, mention comments and in its own system prompt. One line, 40 characters max. Also editable from Settings → General. Without the `hootie_branding` licence feature it is ignored and everyone sees Hootie. |
| `HOOTIE_LOGO_URL` | _(unset — the owl)_ | **Enterprise.** An `https://` link to a `.png`, `.jpg`, `.gif` or `.webp` image used as the assistant's avatar. Ignored unless the licence carries the `hootie_branding` feature. |
| `HOOTIE_ACCENT_COLOR` | _(unset — theme colour)_ | **Enterprise.** Hex colour (`#0a7cff`) for the edge tab and panel header; text on it is black or white, whichever reads better. Ignored unless the licence carries the `hootie_branding` feature. |
| `HOOTIE_GREETING` | _(unset — "Hi, I'm <name>")_ | **Enterprise.** The line the empty panel opens with. One line, 200 characters max. Ignored unless the licence carries the `hootie_branding` feature. |
| `HOOTIE_MODEL` | _(unset)_ | The model Hootie answers with. Set the plain model name (`claude-sonnet-5`, `gpt-5.5`); on the PromptOwl model gateway the server adds PromptOwl's instance prefix (e.g. `default-claude/`) when it calls, and a name that already has one is sent as given. Unset: the gateway's default model, or `claude-sonnet-5` on your own key. Also editable from Settings → General, which lists the models this server's key can reach. Through a gateway, use the gateway's name for it (`ollama/llama3.2`, `gpt-5`, …). |
| `HOOTIE_DEBUG_LOG` | `false` | Testing aid. `true` also logs Hootie's full model request (system prompt with the retrieved nest documents, the conversation) and the full answer. Off in production: those logs carry nest content. A one-line summary per call (model, which key by its last 4 characters, token usage, timing) is always logged. |
| `FEATURE_WORKFLOW_PLANE` | _(unset — off)_ | Enables the workflow plane: typed edges, edge-type registry, governed runs. Optional feature; also toggleable from Settings. |
| `FEATURE_SUBAGENT_RUNS` | _(unset — off)_ | Lets runs spawn nested sub-agent runs (recursion). Gated separately from the plane; requires `FEATURE_WORKFLOW_PLANE`. Also toggleable from Server settings → Features (turning the plane off forces this off too). Opens a recursion surface — enable only after reviewing the depth/fan-out caps. |
| `FEATURE_METACOGNITION` | _(unset — off)_ | Metacognition agents: agent documents **this server runs itself**, as a named persona, on the nest's model key (PromptOwl's gateway, metered in credits; or an own key with the `byok` licence feature, not billed by PromptOwl but still recorded and capped). The agent reads within the folders it is given and the access of the owner/admin who configured it, and can change the nest **only by filing proposals** to the review queue. Requires `FEATURE_WORKFLOW_PLANE`. This is the one exception to "the server never executes" — see `WORKFLOW_PLANE.md`. Also switchable by a superadmin under Settings → Features (`metacognition_enabled`). Off → `/nests/:id/metacognition` answers `404` and the Workflows → Agents tab is hidden. |
| `EXPERIMENTAL_DOC_STREAM` | _(unset — off)_ | **Experimental.** The cross-nest document stream: a Stream page (and a Stream tab on each nest) with one card per document version across every nest the person can read, newest first, filterable by nest, topic (tag), type and author, with the document's open comment threads inline. Also switchable by a superadmin under Settings → Features (`experimental_doc_stream_enabled`), live, no restart. Off → `GET /me/stream` answers `404` and the Stream page and tab are hidden; `/health` reports it as `experimental.doc_stream`. Experimental: its shape may change or the feature may be removed in a later release. |
| `EXPERIMENTAL_DOC_PINS` | _(unset — off)_ | **Experimental — may change or disappear.** Document pins: stewards (the nest owner, a nest admin, the server admin, or a nest-wide reviewer steward) pin documents to the front of a nest for everyone, in the order they choose; anyone who can read a document can pin it for themselves. Pins show as a strip above the nest's document list. Also switchable by a superadmin under Settings → Features (`experimental_doc_pins`), live, no restart. Off → every `/nests/:id/pins` route answers `404` and no pin UI renders. `/health` reports it as `experimental.doc_pins`. |
| `METACOGNITION_ALLOW_PRIVATE_URLS` | _(unset — off)_ | **Development only.** Lets a metacognition agent's feeds and MCP servers be plain-`http` or private/loopback addresses (a local MCP server). Leave off in production: the server fetches these from its own network position, and off is what keeps an agent config from reaching internal services. |
| `METACOGNITION_STARTS_PER_HOUR` | `30` | Manual, `/run` and inbound-hook starts allowed per metacognition agent per hour (schedules are bounded by their own interval). Bounds what any write-tier member can spend by pressing Run. Only starts that create a run count; kept in memory per server process, so it resets on restart. |
| `METACOGNITION_CANCEL_POLL_MS` | `2000` | How often a running metacognition agent checks whether a person cancelled it; a cancel aborts the model call in flight within this interval. |
| `SUBAGENT_MAX_DEPTH` | `8` | Max sub-agent nesting depth (clamped 1..32) — bounds the call tree's HEIGHT so it stays finite/haltable. |
| `SUBAGENT_MAX_CHILDREN` | `16` | Max direct children a single run may spawn (clamped 1..128) — bounds the call tree's WIDTH. Together with `SUBAGENT_MAX_DEPTH` this caps total tree size so a runner can't fork-bomb the DB. |
| `RUN_MAX_STEPS` | `10000` | Max steps a single run may accumulate (clamped 10..100000) — bounds a runaway/hostile runner's step log. |
| `RUN_MAX_CONCURRENT_ROOTS` | `50` | Max concurrently-running root (depth-0) runs per nest (clamped 1..1000). The subagent caps bound a single tree; this bounds how many trees can run at once, so triggers can't flood a nest. |
| `ANTHROPIC_BASE_URL` | _(unset — off)_ | **Enterprise** (licence feature `byok`). Your own model gateway: a LiteLLM (in front of Bedrock, Azure, Ollama or any provider) or other proxy speaking Anthropic's `/v1/messages`. With `ANTHROPIC_API_KEY` as its key, **every** model call this server makes goes through it — Hootie, and agent runs via the run bundle's env floor — so calls and nest content stay on your network, under the gateway's budgets and spend logs. Used only as a pair with the key. Also editable from Settings → Hootie → Model gateway. |
| `ANTHROPIC_API_KEY` | _(unset)_ | **Enterprise** (licence feature `byok`). The key for `ANTHROPIC_BASE_URL` (e.g. a LiteLLM virtual key); checked against the gateway when saved in Settings, never returned by the API (masked tail only). Without a gateway URL it is not used: own provider keys (Anthropic, OpenAI, Google Gemini, xAI Grok, Groq) live in PromptOwl's model gateway under Settings → Hootie → Model keys, and a bare key stored here is handed over to that gateway as the Anthropic key on the first boot with `byok`, then cleared. A key paired with a gateway URL is never handed over. A nest can still set its own `ANTHROPIC_API_KEY` (and `ANTHROPIC_BASE_URL`) in its Tool environment for agent runs. |
| `SECRETS_KEY` | _(unset — a key is generated and stored in the database)_ | Master key for the credentials this server stores encrypted (the secret settings rows and every nest Tool-environment value). Any string; it is hashed to 32 bytes. Optional, and stronger than the default when your deployment has a secret manager: the key then lives outside the database it protects. Values already written under the generated key cannot be read after you set it. See [Runtime settings persistence](#runtime-settings-persistence). |
| `SLACK_WEBHOOK_URL` | _(unset — connector off)_ | Slack incoming-webhook URL for governance-event notifications (review submitted/approved/rejected, collaborator added). `https://` only — the URL embeds a secret. Also editable from Settings in the UI. |
| `MSTEAMS_WEBHOOK_URL` | _(unset — connector off)_ | Microsoft Teams incoming-webhook URL for the same governance events, posted as Adaptive Cards. `https://` only — the URL embeds a secret. Also editable from Settings in the UI. See [Microsoft Teams notifications](#microsoft-teams-notifications). |
| `EMAIL_PROVIDER` | `smtp` | Email transport: `smtp` (uses `SMTP_URL`) or `ses` (AWS SES through the AWS SDK, for servers that can't use SMTP). Also editable from Settings. |
| `SMTP_URL` | _(unset — connector off)_ | SMTP connection URL for email notifications (`smtp://` or `smtps://`, credentials inline). Requires `NOTIFY_EMAIL_FROM` and `NOTIFY_EMAIL_TO`. Also editable from Settings. |
| `SES_REGION` | _(unset — connector off)_ | AWS region for SES (e.g. `us-east-1`) when `EMAIL_PROVIDER=ses`. The From address must be a verified SES identity. |
| `SES_ACCESS_KEY_ID` / `SES_SECRET_ACCESS_KEY` | _(unset)_ | Optional static SES credentials (need `ses:SendEmail`). Saving one email provider in Settings clears the other one's settings. Leave the keys unset to use the AWS default credential chain (IAM role, `AWS_*` env, shared profile). The secret is write-only in Settings. |
| `NOTIFY_EMAIL_FROM` | _(unset)_ | From address for notification emails. |
| `NOTIFY_EMAIL_TO` | _(unset)_ | Comma-separated recipients for notification emails. |
| `NOTIFY_DEBOUNCE_MS` | `15000` | Per-nest buffer window before notifications flush; bursts collapse into one digest message. |

---

## Microsoft Teams notifications

Set `MSTEAMS_WEBHOOK_URL` (or paste the URL into **Server settings → Notifications → Microsoft Teams notifications**) and the server posts the same governance events the Slack connector covers — review requested / approved / rejected, collaborator added, plus per-nest burst digests — to one Teams channel as [Adaptive Cards](https://adaptivecards.io/). Leave it empty to turn the connector off. Delivery is fire-and-forget with a short timeout: a Teams outage or a bad URL never slows down or fails the action that triggered the message.

> Naming note: the setting is `msteams_webhook_url` / `MSTEAMS_WEBHOOK_URL`
> because "teams" in this product means user groups (the `/teams` API), not
> Microsoft Teams.

### Create the incoming webhook in a Teams channel

Microsoft retired the classic Office 365 "Incoming Webhook" connectors; webhooks are now created with the **Workflows** (Power Automate) app:

1. In Microsoft Teams, open the channel that should receive notifications, click **⋯ (More options) → Workflows**.
2. Pick the template **"Post to a channel when a webhook request is received"** (searching for "webhook" finds it), sign in if prompted, and confirm the team + channel.
3. Create the flow and **copy the HTTP POST URL** it shows (a `https://….logic.azure.com/…` or `https://….powerplatform.com/…` address).
4. Paste that URL into **Server settings → Notifications → Microsoft Teams notifications** (or set `MSTEAMS_WEBHOOK_URL`).
5. Save, then click **Send test** on the card to post a test message and confirm the channel receives it. (The button tests the *saved* URL — save first, then test. The Slack card has the same button.)

If your tenant still has a legacy Office 365 connector webhook, it is expected to accept the same payload envelope (legacy connectors documented support for Adaptive Card attachments, though we have not verified one end-to-end — the card's plain-text `fallbackText` is the safety net) — but create new hooks via Workflows.

The URL embeds a secret — anyone holding it can post to the channel, so treat it like a password (it is why the setting requires `https://`). The server sends the standard envelope Workflows expects: `{"type": "message", "attachments": [{"contentType": "application/vnd.microsoft.card.adaptive", "content": {…card…}}]}` with a plain-text `fallbackText` for clients that cannot render cards.

Per-nest connector rows post the same Adaptive Card format to a nest-specific webhook, with per-event filtering: `POST /nests/:id/connectors` with a JSON body like `{"channel": "teams", "url": "https://…", "events": ["review_requested", "review_rejected"]}` (`events` is any of `review_requested`, `review_approved`, `review_rejected`, `run_failed`, `mention`, `review_escalated` — a review passed the nest's review SLA and moved up a rung — or `["*"]`; subscription is explicit, so list `review_escalated` next to `review_requested` to hear escalations on that row; the server-wide webhook above posts review requests and escalations with no row at all; the `url` may be an `env:KEY` reference into the nest's env store). Manage rows with `GET`/`PATCH`/`DELETE` on the same path.

---

## Single sign-on (OIDC)

This section is the admin guide to single sign-on. It covers what SSO does, how to set it up for each identity provider, what happens to existing accounts, API keys and agents, and how to fix each sign-in error.

**In this section:** [Overview](#overview) · [Prerequisites](#prerequisites) · [Settings reference](#settings-reference) · [Microsoft Entra ID](#connect-microsoft-entra-id) · [Google](#connect-google) · [Okta](#connect-okta) · [Keycloak](#connect-keycloak) · [Any other OIDC provider](#connect-any-other-oidc-provider) · [User lifecycle](#user-lifecycle) · [API keys, agents and MCP](#how-sso-relates-to-api-keys-agents-and-mcp) · [Shared deployments](#hosted-and-shared-deployments) · [Department auto-tagging](#department-auto-tagging) · [Troubleshooting](#troubleshooting-sso-sign-in)

### Overview

With SSO turned on, the login page shows one more button. Someone clicks it, signs in at your identity provider (IdP), and comes back signed in to ContextNest. The session is the same one a password login creates: an httpOnly cookie that lasts 30 days.

- **Protocol:** OpenID Connect, authorization-code flow with PKCE (S256). `GET /auth/oidc/login` sends the browser to your IdP. `GET /auth/oidc/callback` gets the code back, redeems it, checks the ID token (signature against the issuer's JWKS, issuer, audience, expiry, nonce) and starts the session. Endpoint details are in `API.md → GET /auth/oidc/login`.
- **Providers:** any OIDC provider that meets the [requirements below](#connect-any-other-oidc-provider). The settings page has a **Google sign-in** card and an **Enterprise single sign-on** card (Microsoft Entra ID by tenant ID, or any issuer URL such as **Okta** or **Keycloak**). SAML is not supported.
- **Plans:** Google works on **every plan** (Free, Self-Hosted, Enterprise). Microsoft Entra ID, Okta, Keycloak and any other issuer need **Enterprise** (licence feature `sso`, included with Enterprise). Without it the Enterprise card is locked and the server refuses to switch to such an issuer or turn one on (`403 sso_required`). A server already signing in through one keeps working; only changing it, or turning it back on, needs Enterprise.
- **Button label:** "Sign in with Microsoft" when the issuer host is `login.microsoftonline.com`, "Sign in with Google" for `accounts.google.com`, and "Sign in with SSO" for anything else. The button only appears when SSO is on **and** the issuer, client ID and client secret are all set.
- **Where to configure:** **Admin → Server settings** in the left rail: switch Single sign-on on under **Features**, then fill in the **Single sign-on** tab that appears — or set the `OIDC_*` environment variables. Changes made in the UI take effect at once, without a restart.
- **Who can configure:** a server admin. That is the license admin or a superadmin (granted on **Admin → Teammates**, or listed under `super_admins` in `access.yaml`). In `AUTH_MODE=open` nobody signs in, so SSO has no effect there. SSO is for `AUTH_MODE=key`, the default.
- **One setup per server:** there is a single issuer, client and domain allowlist for the whole server. See [Hosted and shared deployments](#hosted-and-shared-deployments).

SSO is separate from three other features with similar names:

- **Sign in with PromptOwl**, the device flow (`PROMPTOWL_SIGN_IN_GATE`).
- **One-click "Open Community" login** from PromptOwl (`GET /auth/sso`, **Server settings → Community sites**).
- **Agent SSO** token exchange ([below](#agent-sso-token-exchange)).

Each has its own settings.

### Prerequisites

1. **An https address.** The issuer must be `https://` (the server refuses anything else). Your ContextNest server should also be on https: the session and flow cookies get the `Secure` flag on https, and most IdPs only accept an `http://` redirect URI for `localhost`.
2. **`PUBLIC_BASE_URL` set to that address.** Set it on **Server settings → Basic → Public base URL**, or in the environment, e.g. `https://nest.acme.com`, with no trailing path. The redirect URI is built from it. If it is unset, the server uses the origin of the incoming request, which behind a reverse proxy is whatever `Host` header the proxy forwards. See the `PUBLIC_BASE_URL` row in the env var table for why you should always pin it.
3. **The redirect URI registered at your IdP, exactly:**

   ```
   <PUBLIC_BASE_URL>/auth/oidc/callback
   ```

   The Single sign-on tab shows this value with a **Copy** button. Before you save, it is built from the Public base URL you have typed, or from this browser's address if that field is empty. People must reach ContextNest at this same address. The flow cookies are set on the host where sign-in starts, so starting on a different host fails with `state_mismatch`.
4. **Outbound access from the server to the IdP.** The server fetches `<issuer>/.well-known/openid-configuration`, the JWKS and the token endpoint. Each call times out after 10 seconds.
5. **A server clock that is correct (NTP).** ID-token expiry is checked with no clock tolerance.
6. **A second way in while you test.** Keep password or PromptOwl sign-in on until an SSO login has worked. The server will not let you turn off password and PromptOwl sign-in unless SSO is on and fully configured, so there is always a way in.

### Settings reference

All of these are on **Admin → Server settings → Single sign-on**, in the **Google sign-in** or **Enterprise single sign-on** card (whichever is on). The exception is `PUBLIC_BASE_URL`, which is on the **General** tab. One **Save** button, next to the page title, saves every tab. If a value is set both in the environment and in the UI, see [Runtime settings persistence](#runtime-settings-persistence) for which one wins.

| Env var | UI field | Default | What it does |
|---|---|---|---|
| `OIDC_ENABLED` | **Single sign-on** switch on the **Features** tab | `false` | Turns SSO on. The server refuses to turn it on until the issuer, client ID and client secret are all set. If one of them is cleared later while SSO is still on, the button disappears and the card warns *Enabled but not configured*. |
| `OIDC_ISSUER` | The **Google sign-in** switch (fixed issuer), or **Directory (tenant) ID** / **Issuer URL** in the **Enterprise single sign-on** card | `""` | Google's issuer works on every plan; any other needs Enterprise (licence feature `sso`). The issuer, e.g. `https://login.microsoftonline.com/<tenant-id>/v2.0`, `https://accounts.google.com`, `https://acme.okta.com` or `https://sso.acme.com/realms/acme`. **https only.** In the environment, a non-https value is ignored, a warning is logged (`[config] OIDC_ISSUER rejected`) and SSO stays off. In the UI, saving it fails. A trailing slash is removed. The issuer must serve `/.well-known/openid-configuration`, and the `issuer` in that document must match this value exactly (a trailing slash aside). |
| `OIDC_CLIENT_ID` | **Client ID** | `""` | The client (application) ID from your IdP. The ID token's audience must equal it. |
| `OIDC_CLIENT_SECRET` | **Client secret** | `""` | The client secret from your IdP. **Write-only:** the UI and `GET /admin/settings` only show whether it is set. Paste a new one to replace it. **Clear secret** removes it. The server sends it in the body of the token request (`client_secret_post`). |
| `OIDC_ALLOWED_DOMAINS` | **Allowed email domains** | `""` (any domain) | A comma-separated list of domains, e.g. `acme.com, contractors.acme.com`, stored lowercase. The domain of the user's email (the part after the last `@`) must be on the list **exactly**. Subdomains are not included automatically: `acme.com` does not allow `eu.acme.com`. The UI rejects anything that is not a bare domain. |
| `OIDC_AUTO_PROVISION` | **Auto-provision new users** | `true` | On: anyone the IdP signs in, and the domain list allows, gets an account the first time. Off: only emails that already have an account can sign in. Others get `not_invited`. See [User lifecycle](#user-lifecycle). |
| `OIDC_DEPARTMENT_TAGGING` | **Department auto-tagging** | `false` | Adds `dept:<department>` to documents a user creates. See [Department auto-tagging](#department-auto-tagging). |
| `PUBLIC_BASE_URL` | **General → Public base URL** | `""` (request origin) | The base of the redirect URI and of the post-logout return address. |

The following are **fixed** and cannot be configured:

- Scopes: `openid email profile`.
- Response type: `code`, with PKCE `S256`.
- Client authentication: `client_secret_post`. `client_secret_basic` and `private_key_jwt` are not supported.
- ID-token algorithm: `RS256` only.
- Flow cookies (state, nonce, PKCE verifier) last 10 minutes.
- Discovery documents are cached for 5 minutes.
- Calls to the IdP time out after 10 seconds.
- Sessions last 30 days.
- Rate limit: 100 requests per 15 minutes per client IP, counted separately for `/auth/oidc/login` and `/auth/oidc/callback`.

The `/admin/settings` API names for the same fields are `oidc_enabled`, `oidc_issuer`, `oidc_client_id`, `oidc_client_secret`, `oidc_allowed_domains`, `oidc_auto_provision` and `oidc_department_tagging` (see `API.md`).

### Connect Microsoft Entra ID

1. **Register an app.** In the Entra admin center, go to *Identity → Applications → App registrations → New registration*. Name it, e.g. "ContextNest", and leave the account type at *Accounts in this organizational directory only* (single tenant).
2. **Add the redirect URI.** In the registration, go to *Authentication → Add a platform → Web* and paste the redirect URI from the Single sign-on tab (`https://<your-server>/auth/oidc/callback`).
3. **Create a client secret.** Go to *Certificates & secrets → New client secret*. Copy the secret **Value**, not the Secret ID. It is shown only once. Note when it expires: after that date, sign-in fails with `exchange_failed` until you paste a new secret.
4. **Collect the IDs.** On the app's *Overview* page, copy the **Application (client) ID** and the **Directory (tenant) ID**.
5. **Fill in ContextNest** (Enterprise plan). On **Admin → Server settings → Single sign-on**, turn on the **Enterprise single sign-on** card and paste the tenant ID into **Directory (tenant) ID**. The issuer becomes `https://login.microsoftonline.com/<tenant-id>/v2.0`. Paste the client ID and the secret value. You can also set **Allowed email domains** to your organization's domains. Turn the switch **On** and **Save**. The switch and the fields can go in the same save.
6. **Test.** On **Server settings → Network & status**, click **Test discovery** to confirm this server can reach Entra. Then open the login page in a private window. A **Sign in with Microsoft** button should appear and take you through Entra.

The same steps, with copy buttons for every value Entra asks for, are on **Server settings → Network & status → Microsoft Entra ID sign-in**.

Entra-specific notes:

- **Use the tenant ID (a GUID), not `common`, `organizations` or a domain name.** The server requires the discovery document's `issuer` to match the configured issuer exactly. For the multi-tenant endpoints, Entra's document contains the placeholder `{tenantid}`, so the check fails and sign-in stops with `discovery_failed`. Only single-tenant sign-in is supported.
- **Email claim.** Entra v2 ID tokens often have no `email` claim. The server then uses `preferred_username` (the UPN). The address people sign in with may therefore be their UPN, which may differ from their mail address. Account matching uses this address (see [User lifecycle](#user-lifecycle)).
- **Only let assigned users in (optional).** Go to *Enterprise applications → (your app) → Properties → Assignment required? → Yes*, then assign users or groups. Entra then refuses anyone else. Depending on where Entra stops the sign-in, the user sees either Entra's own error page or `provider_error`.
- **Sign-out:** Entra publishes an `end_session_endpoint`, so ContextNest signs the user out of Entra as well (see [Offboarding and sign-out](#revoking-access-offboarding)).

### Connect Google

1. **Choose the project.** In the Google Cloud console, pick (or create) the project that will own the sign-in client.
2. **Set up the consent screen.** Go to *APIs & Services → OAuth consent screen*. Newer consoles call this *Google Auth Platform → Branding / Audience*.
   - **Internal:** only accounts in your Google Workspace organization can sign in. This is the right choice for a company server.
   - **External:** any Google account can sign in. While the app is in *Testing*, only the test users you list can sign in.
3. **Create the client.** Go to *APIs & Services → Credentials → Create credentials → OAuth client ID* (newer consoles: *Google Auth Platform → Clients → Create client*). Choose **Application type: Web application**.
4. **Add the redirect URI.** Under **Authorized redirect URIs**, add the redirect URI from the Single sign-on tab exactly, then click **Create**.
5. **Copy the credentials.** Copy the **Client ID** and **Client secret**.
6. **Fill in ContextNest** (every plan). On **Admin → Server settings → Single sign-on**, turn on the **Google sign-in** card. The issuer becomes `https://accounts.google.com`. Paste the client ID and secret, and **set Allowed email domains** to your Workspace domains. Turn the switch **On**, **Save**, and test in a private window. A **Sign in with Google** button should appear.

Google-specific notes:

- **Set Allowed email domains.** `accounts.google.com` will sign in *any* Google account. With auto-provision on and no domain list, anyone with a Google account gets an account on your server. The Single sign-on tab shows a warning when that combination is set.
- **Sign-out:** Google has no `end_session_endpoint`. Signing out of ContextNest ends the ContextNest session only. The user stays signed in to Google.

### Connect Okta

These are the standard steps in the Okta Admin Console. The Okta-side behavior noted at the end has not been tested against a live Okta org, so check it on yours.

1. **Create the app integration.** Go to *Applications → Applications → Create App Integration*. Choose **Sign-in method: OIDC - OpenID Connect** and **Application type: Web Application**, then **Next**.
2. **General settings.** Name it, e.g. "ContextNest". Under **Grant type**, keep **Authorization Code** checked.
   - **Sign-in redirect URIs:** the redirect URI from the Single sign-on tab, e.g. `https://nest.acme.com/auth/oidc/callback`.
   - **Sign-out redirect URIs:** your base URL with a trailing slash, e.g. `https://nest.acme.com/`. This is the address ContextNest asks Okta to return to after sign-out.
   - **Assignments:** choose who may use the app (everyone, or selected groups). **Save**.
3. **Copy the credentials.** On the app's **General** tab, copy the **Client ID** and a **Client secret**. **Client authentication** should be **Client secret**, not *Public key / Private key*.
4. **Find the issuer.** It is one of these:
   - Your Okta org URL, e.g. `https://acme.okta.com`. This is the org authorization server.
   - A custom authorization server, e.g. `https://acme.okta.com/oauth2/default` (*Security → API → Authorization Servers → Issuer URI*).

   Either works, as long as the value you enter matches the `issuer` in `<issuer>/.well-known/openid-configuration`. Open that URL in a browser to check. If you use a custom domain, use the issuer the discovery document shows.
5. **Fill in ContextNest** (Enterprise plan). On **Admin → Server settings → Single sign-on**, turn on the **Enterprise single sign-on** card and paste the issuer into **Issuer URL**. Paste the **Client ID** and **Client secret**, set **Allowed email domains** if you want, turn it **On** and **Save**. The login page shows **Sign in with SSO**.

Okta notes that were **not verified against a live Okta org:**

- **Client authentication method.** ContextNest sends the secret in the request body (`client_secret_post`). If sign-in fails with `exchange_failed` and the server log shows `[oidc] token exchange failed with status 401`, check the app's `token_endpoint_auth_method`. The Admin Console may not show it, so use Okta's Apps API to set it to `client_secret_post` and try again.
- **Sign-out.** ContextNest sends `post_logout_redirect_uri` and `client_id` to Okta's logout endpoint, but not `id_token_hint`. If Okta shows an error page on sign-out, the ContextNest session has **already** ended (it is deleted before the redirect). Only the Okta session is left open.

### Connect Keycloak

These steps are for the current admin console (Keycloak 19 and later).

1. **Create the client.** In your realm, go to *Clients → Create client*. Choose **Client type: OpenID Connect** and enter a **Client ID**, e.g. `contextnest`. **Next**.
2. **Capability config.** Turn **Client authentication** **On**. This makes it a confidential client, which ContextNest requires. Keep **Standard flow** checked. **Next**.
3. **Login settings.**
   - **Valid redirect URIs:** the redirect URI from the Single sign-on tab.
   - **Valid post logout redirect URIs:** your base URL with a trailing slash, e.g. `https://nest.acme.com/`.

   **Save**.
4. **Copy the secret.** On the client's **Credentials** tab, keep **Client Authenticator: Client Id and Secret** and copy the **Client Secret**.
5. **Find the issuer.** It is `https://<keycloak-host>/realms/<realm>`. Older Keycloak versions (before 17) add `/auth`: `https://<keycloak-host>/auth/realms/<realm>`. Open `<issuer>/.well-known/openid-configuration` and use its `issuer` value exactly. If Keycloak runs behind a proxy without a correct hostname setting, the document may show an internal or `http://` issuer. That fails with `discovery_failed`, so fix Keycloak's hostname configuration first.
6. **Fill in ContextNest** (Enterprise plan). In the **Enterprise single sign-on** card on **Admin → Server settings → Single sign-on**, paste the issuer, client ID and client secret, turn it **On** and **Save**. The login page shows **Sign in with SSO**.

Keycloak-specific notes:

- **Verified email is required.** Keycloak includes `email_verified` in the ID token, and ContextNest refuses a token where it is `false` (`email_not_verified`). Users created in the admin console start with *Email verified* **off**. Turn it on for each user, or have users verify their address.
- **Users need an email address.** A user without one produces a token ContextNest cannot use (`invalid_token`).
- **Lock down open registration.** If the realm allows self-registration, anyone can create a Keycloak account with any address. Turn off *User registration* or set **Allowed email domains**. See the [trust assumption](#email-verification-trust-assumption).
- **Signature algorithm.** Keep the realm's default `RS256`. If the client's *ID token signature algorithm* is set to anything else (`ES256`, `PS256`, …), every login fails with `invalid_token`.
- **Department (optional).** For [department auto-tagging](#department-auto-tagging), add a *User Attribute* mapper to the client's dedicated scope. Set the token claim name to `department`, the claim type to String, and turn on *Add to ID token*.

### Connect any other OIDC provider

Any provider that meets all of these requirements works. Each one is checked by the server, and a failure shows up as the error code given.

| Requirement | Error if not met |
|---|---|
| Issuer is `https://` and serves `<issuer>/.well-known/openid-configuration` | Refused when saving (UI), or `not_configured` (env) / `discovery_failed` |
| The discovery document has `issuer`, `authorization_endpoint`, `token_endpoint` and `jwks_uri`, and its `issuer` matches the configured issuer exactly (a trailing slash aside) | `discovery_failed` |
| Authorization-code flow, with the client secret in the request body (`client_secret_post`). PKCE `S256` parameters are always sent. | `exchange_failed` |
| The token response includes an `id_token` | `exchange_failed` |
| The ID token is signed `RS256` with a key in `jwks_uri`, its `aud` is the client ID, it has not expired, and it returns the `nonce` that was sent | `invalid_token` |
| The ID token has an email-shaped `email` claim, or failing that a `preferred_username` claim | `invalid_token` |
| `email_verified` is not `false`. A missing claim is accepted. | `email_not_verified` |

Optional claims the server uses: `name` (display name for new accounts) and `department` (see [Department auto-tagging](#department-auto-tagging)). If the discovery document has an `end_session_endpoint`, sign-out also ends the IdP session.

Enter the issuer in **Issuer URL** (the page shows *Custom issuer*), fill in the client ID and secret, and register the redirect URI with the provider.

### User lifecycle

**How accounts are matched.** ContextNest links an SSO login to an account **by email address only**. It does not store the IdP's subject ID (`sub`). The address comes from `email`, or from `preferred_username` if `email` is missing. It is trimmed and lowercased, and matched against existing accounts without regard to case. As a result:

- **An existing password account with the same email is the same account.** The first SSO login signs into it, with the same nests, teams, stewardship roles, API keys and admin rights. SSO does not change or remove the password, so the person can still sign in with it, unless you turn password sign-in off (see [Making SSO the only way in](#making-sso-the-only-way-in)).
- **Invited people can use SSO straight away.** An invite (Teammates, a nest share, a team, a steward assignment) creates the account and sends a temporary password. If the invited email matches their IdP email, they can click the SSO button instead. Any first sign-in clears the account's *Invited* badge.
- **A changed email is a new account.** If someone's email or UPN changes at the IdP, their next SSO login does not match the old account. With auto-provision on, they get a new, empty account. With it off, they get `not_invited`. Share their nests with the new address again, and remove the old account on Teammates.
- **Admin rights belong to the account,** not to how it signed in. A superadmin listed by email in `access.yaml` or granted on Teammates is still an admin when signing in with SSO.

**Auto-provision on (the default).** The first successful SSO login by an unknown email creates an account. The display name comes from the `name` claim, and the password is random and unusable. A new account sees only nests shared with it (directly or through a team) and nests whose visibility is *Organization* or *Public*. The account can sign in only through SSO, unless an admin sets a password with **Reset password** on Teammates. Auto-provision also applies when **Manual sign-in** is *Invite only*, because that setting governs email-and-password registration, not SSO. Limit who can get in with **Allowed email domains**, or by assigning the app to specific users or groups at the IdP.

**Auto-provision off (invite-only SSO).** Only emails that already have an account can sign in. Everyone else is sent back with `not_invited`. Add people first with **Admin → Teammates → Invite Teammate**, or by sharing a nest or document with their email. They can then use the SSO button.

**Allowed email domains** apply to every SSO login, new and existing accounts alike. An existing account whose domain is not on the list gets `domain_not_allowed`. It can still use password or PromptOwl sign-in if those are on.

#### Making SSO the only way in

On **Server settings → Basic**, set **Manual sign-in** to **Off** and **Sign in with PromptOwl** to **Off**. The login page then shows only the SSO button, and `POST /auth/login` / `POST /auth/register` return `403`. The server refuses this combination unless SSO is on and has an issuer, client ID and secret. It also refuses to turn SSO off or clear its settings while SSO is the only way in.

Consider a break-glass option: set **Sign in with PromptOwl** to **Admins only**. The license admin can then still sign in through `?admin=1` on the login page if the IdP is down.

API keys keep working either way. They are not a sign-in method (see [below](#how-sso-relates-to-api-keys-agents-and-mcp)).

### Revoking access (offboarding)

**Disabling someone at the IdP only blocks new SSO logins.** It does not affect:

- ContextNest sessions they already have. These stay valid until they expire, up to 30 days after login.
- Their **API keys**. These do not expire and never contact the IdP.
- Their password, if the account had one or an admin has set one, while password sign-in is on.

To cut access completely, **remove the user in ContextNest**: go to **Admin → Teammates**, find the person and click **Remove**. This deletes their account, all their API keys, their active sessions, their stewardship roles and their nest-collaborator grants in one step. Documents they wrote stay in their nests. A few limits apply:

- Removal is refused while the user **owns** nests. Transfer or delete those nests first.
- A server admin cannot be removed until their superadmin access is revoked.
- Nobody can remove their own account.

The full procedure has two steps:

1. **Disable the user at the IdP.** Do this first. With auto-provision on, a user who is still active at the IdP can sign in again after removal and get a new, empty account.
2. **Remove the user on Admin → Teammates.** This ends their sessions and revokes their keys.

Bearers minted by [Agent SSO](#agent-sso-token-exchange) look up the user by email on every request, so they stop working once the user is removed.

**Sign-out (RP-initiated logout).** When someone who signed in with SSO clicks **Log out**, the app goes to `GET /auth/oidc/logout`. This deletes the ContextNest session and cookies. Then, if the IdP publishes an `end_session_endpoint` (Entra, Okta and Keycloak do; Google does not), it sends the browser there with `post_logout_redirect_uri=<PUBLIC_BASE_URL>/` and `client_id`, so the IdP session ends too. Without that, the next click on the SSO button would sign the person straight back in. Register `<base URL>/` as a sign-out / post-logout redirect URI at IdPs that require it (Okta, Keycloak). If the IdP has no logout endpoint, or cannot be reached, the local session is still cleared and the user lands on the login page.

### How SSO relates to API keys, agents and MCP

SSO controls how **people sign in to the web app**. It does not control how programs connect. Turning SSO on changes nothing for existing keys or agent connections.

| Way in | Effect of turning on SSO |
|---|---|
| **Browser, email and password** | Keeps working. Controlled by **Manual sign-in** (Server settings → Basic). |
| **Browser, Sign in with PromptOwl** | Keeps working. Controlled by **Sign in with PromptOwl** (Server settings → Basic). |
| **Browser, SSO button** | New. Creates the same 30-day session as a password login. |
| **API keys (`cnst_…`)**, used by the REST API, the `ctx` CLI and MCP clients | **No change.** Any signed-in user, however they signed in, creates keys on **Workspace → API keys**, and keys are checked without contacting the IdP. Disabling someone at the IdP does **not** revoke their keys. Removing them on Teammates does. |
| **MCP clients** (Claude Desktop, Claude Code, Cursor, VS Code…) | **No change.** They connect to `<server>/mcp` or `<server>/nests/<id>/mcp` with an API key. They do not sign in through your IdP. |
| **Agent SSO (token exchange)** | Separate and **off** by default. An agent that already holds an Entra or Google ID token for a user exchanges it at `POST /auth/token-exchange` for a short-lived MCP bearer. It has its own switches (Single sign-on tab → **Agent SSO — token exchange** card) but uses **Allowed email domains** and **Auto-provision new users** from the SSO card. See [Agent SSO (token exchange)](#agent-sso-token-exchange). |
| **One-click "Open Community" login from PromptOwl** (`GET /auth/sso`) | Not related. It uses signed tickets from PromptOwl (**Server settings → Community sites**), not your IdP. |

### Hosted and shared deployments

The SSO settings apply to the **whole server**: one issuer, one client, one domain list and one auto-provision setting for every user. There is no per-organization or per-nest IdP. On a server that hosts several organizations (`SHARED_DEPLOYMENT=true`, such as the PromptOwl-hosted service):

- Turning on SSO puts the same button in front of **every** user of the server, and it signs in against one organization's IdP.
- With auto-provision on, anyone that IdP signs in (and the domain list allows) gets an account on the shared server. That account can read every nest whose visibility is *Organization* or *Public*, which on a shared server means nests belonging to other customers.
- Only a server admin, meaning the operator, can change these settings. Customers of a shared server cannot bring their own IdP.

An organization that needs its own IdP should run its own ContextNest server. Per-organization identity (SAML / SCIM, a multi-tenant admin console) is in the Enterprise edition (see `README.md`).

### Department auto-tagging

With `OIDC_DEPARTMENT_TAGGING` on (**Admin → Server settings → Single sign-on → Department auto-tagging**), every document a user **creates** is tagged `dept:<slugified-department>` from their directory department. For example, a user in *Customer Success* creates documents tagged `dept:customer-success`. It applies to new documents only: edits never add or change the tag, and existing documents are never tagged afterwards. Users without a department (password accounts, or an IdP that does not send the claim) create untagged documents, with no error.

The department comes from the **`department` claim** in the OIDC ID token. It is saved on the user at every SSO login. A new value replaces the old one and a missing claim clears it, so directory moves take effect at the user's next sign-in. Whitespace is trimmed and collapsed, and the value is cut to 120 characters.

Microsoft Entra ID does **not** send the claim by default. Add it to the app registration: *Token configuration → Add optional claim → Token type: **ID** → select **department** → Add*. Grant the suggested Microsoft Graph permission if asked, and make sure users' *Department* field is filled in in Entra. Other IdPs work too, as long as they send a string `department` claim in the ID token (e.g. a Keycloak user-attribute mapper, see [Keycloak](#connect-keycloak)).

> **Privacy note:** the `dept:<slug>` tag is part of the document's visible
> metadata. Anyone who can read the document (collaborators, shared nests,
> public nests) can see the creator's directory department. That is
> PII-adjacent organizational data. Think about this before turning it on for
> servers where documents are shared beyond the creator's own team or made
> public.

### Email-verification trust assumption

An ID token whose `email_verified` claim is **explicitly `false`** (the boolean or the string `"false"`) is refused with `?sso_error=email_not_verified`. If the claim is **missing**, the server trusts the email claim. Microsoft Entra ID v2 tokens often leave it out, and both Entra and Google guarantee address ownership, so refusing when it is missing would break the main providers.

This is a deliberate trust assumption. **If your IdP allows unverified, self-registered emails (e.g. an open Keycloak realm), set Allowed email domains and turn off self-registration at the IdP.** Otherwise anyone who can claim an arbitrary email at your IdP can sign in as the local account with that email, including an admin's.

### Troubleshooting SSO sign-in

When an SSO sign-in fails, the browser lands on `/?sso_error=<code>`. The app shows the message below as a toast, removes the parameter from the address bar and shows the normal sign-in options. For the codes that involve the IdP, the server log has the details: `[oidc] discovery failed: …`, `[oidc] token exchange failed with status <n>`, `[oidc] ID token validation failed: …` and `[oidc] provisioning/session failed: …`.

| `sso_error` | Message the user sees | Cause | Fix |
|---|---|---|---|
| `disabled` | Single sign-on is turned off on this server. | `OIDC_ENABLED` is off, but something (an old bookmark, a link) opened `/auth/oidc/login` or the callback. | Turn SSO on, or remove the link. |
| `not_configured` | Single sign-on isn't fully configured. Contact your admin. | SSO is on, but the issuer, client ID or client secret is empty. This also happens when an `OIDC_ISSUER` in the environment was ignored for not being `https://` (look for `[config] OIDC_ISSUER rejected` in the log). | Fill in all three on the Single sign-on tab. The issuer must be `https://`. |
| `rate_limited` | Too many sign-in attempts. Wait a moment and try again. | More than 100 sign-in requests from one client IP in 15 minutes. Behind a proxy that does not set `X-Forwarded-For` / `X-Real-IP`, every user shares the proxy's IP. | Wait up to 15 minutes. Make sure your proxy passes the real client IP. |
| `discovery_failed` | Couldn't reach the identity provider. Try again, or contact your admin. | The server could not load `<issuer>/.well-known/openid-configuration`: wrong issuer URL, no outbound network access, a timeout after 10 seconds, a non-200 response, missing required fields, or **an `issuer` in the document that differs from the configured issuer**. Entra `common` / `organizations`, or an Entra domain name in place of the tenant GUID, fail on that last check. So does a Keycloak that reports an internal hostname. | Open the discovery URL yourself and copy its `issuer` value exactly into **Issuer URL**. Check that the server can reach the IdP. |
| `provider_error` | Your identity provider declined the sign-in. Try again. | The IdP returned `?error=…` to the callback instead of a code. Typical reasons: the user cancelled or declined consent, the user is not assigned to the app, or a conditional-access policy blocked the sign-in. Some IdPs show their own error page for these cases instead of returning. | Check the IdP's sign-in logs for the reason. Assign the user or group to the app, or fix the policy. |
| `state_mismatch` | The sign-in attempt expired or didn't match this browser. Try again. | The flow cookies were missing or did not match the `state` sent back. The user took more than 10 minutes at the IdP, the browser blocked cookies, or sign-in started on a different host from the redirect URI (e.g. started at `http://10.0.0.5:3000` with a redirect URI on `https://nest.acme.com`). Opening an old callback URL again also causes it. | Start again from the login page. Make sure people use the same address as `PUBLIC_BASE_URL`. |
| `exchange_failed` | Sign-in couldn't be completed with the identity provider. Try again. | The code could not be exchanged for an ID token. The token endpoint returned an error (wrong or **expired client secret**, a client ID for a different app, a redirect URI that does not match, or an IdP that requires `client_secret_basic` or `private_key_jwt`), the call timed out, no `code` came back, or the response had no `id_token` (e.g. the `openid` scope is not allowed). | Paste a new client secret. Check the client ID and redirect URI. Set the IdP client to send the secret in the request body (`client_secret_post`). The log shows the HTTP status. |
| `invalid_token` | The identity provider returned an invalid sign-in token. Try again. | The ID token failed a check: signature, issuer, audience (`aud` is not the client ID), expiry or not-before (**server clock off**), algorithm not `RS256`, or the nonce did not match. It also happens when the token has no email-shaped `email` or `preferred_username` claim, e.g. a Keycloak user with no email address. | Check the client ID and the IdP's ID-token signing algorithm (`RS256`). Sync the server clock with NTP. Give the user an email address at the IdP. |
| `email_not_verified` | Your identity provider reports your email address as unverified. … | The ID token has `email_verified: false`. This is common with Keycloak users created by an admin. | Mark the email as verified at the IdP, or have the user verify it. See the [trust assumption](#email-verification-trust-assumption). |
| `domain_not_allowed` | Your email domain isn't allowed on this server. Contact your admin. | The domain of the user's email is not on **Allowed email domains**. Matching is exact, so subdomains must be listed separately. With Entra, the address may be the UPN rather than the mail address. | Add the domain to the list, or have the user sign in with an address on an allowed domain. |
| `not_invited` | No account exists for your email on this server. Ask your admin for an invite. | **Auto-provision new users** is off, and no account has this email. The email may also have changed at the IdP (see [User lifecycle](#user-lifecycle)). | Invite the person on **Admin → Teammates**, or share a nest with their email, or turn auto-provision on. |
| `service_error` | Something went wrong signing you in. Please try again. | A database error while finding or creating the account or starting the session. | Check the server log (`[oidc] provisioning/session failed`) and the database connection. |

**Errors that appear at the IdP, not in ContextNest.** Some failures stop at the IdP's own error page, and the browser never comes back. The most common one is a redirect URI that is not registered exactly: Entra `AADSTS50011`, Google `Error 400: redirect_uri_mismatch`, or Okta and Keycloak "invalid redirect uri". Google also blocks, on its own page, users outside an *Internal* consent screen's organization, and users who are not on the test list while the app is in *Testing*. Copy the redirect URI from the Single sign-on tab again and compare it character by character: scheme, host, port, path, and no trailing slash. Check that it matches `PUBLIC_BASE_URL`.

**No SSO button on the login page.** The button appears only when SSO is on *and* the issuer, client ID and secret are all set. The Single sign-on tab warns *Enabled but not configured* when one is missing. The page reads this state from `GET /health` (`oidc_enabled`, `oidc_issuer`).

**Other `sso_error` codes.** `not_supported`, `missing_ticket`, `invalid_ticket`, `bad_audience`, `ticket_used` and `sign_in_restricted` come from the PromptOwl one-click login (`GET /auth/sso`), not from OIDC. See `API.md → GET /auth/sso` and **Server settings → Community sites**. `rate_limited` and `service_error` are used by both flows.

---

## Agent SSO (token exchange)

`POST /auth/token-exchange` lets an external agent, acting for a user your IdP (Microsoft Entra / Google) has **already** authenticated, exchange that IdP's ID token for a short-lived MCP bearer — no second login, no static API key. RFC 8693-shaped. **Off by default and security-critical**: it trusts a token minted elsewhere and hands back access, so read this section before enabling it.

Configure it with the `SSO_TOKEN_EXCHANGE_ENABLED` / `MCP_SIGNING_SECRET` / `MS_*` / `GOOGLE_*` vars above, or from **Admin → Server settings → Single sign-on → Agent SSO — token exchange** (server admins). It reuses `OIDC_ALLOWED_DOMAINS` and `OIDC_AUTO_PROVISION` — the same who-may-sign-in policy as browser login.

**Who this is for — and who it is not.** The minted bearer is short-lived by design (`MCP_TOKEN_TTL_SECONDS`, default 300s, hard ceiling 3600s), and there is no refresh token: renewal means calling `POST /auth/token-exchange` again with the IdP token. So this fits a **programmatic** client — an agent runtime, a backend service, a desktop app that already did an MSAL/Google sign-in — that can re-exchange in code before a session or on a `401`, with no human involved.

It does **not** fit a client whose credential is typed once into a config file (Claude Desktop, Cursor, any `mcpServers` JSON block): nothing here rewrites that file, and the ceiling is an hour, so the connection would break repeatedly. Those clients keep using a long-lived API key (`cnst_…`) — this endpoint is additive and changes nothing about API-key or browser sign-in.

**What is verified** on the inbound `subject_token`, before anything is minted:

- **signature** against the provider's JWKS, algorithm pinned to `RS256`
- **issuer** — exact per provider (the tenant-scoped Entra issuer, or Google's)
- **audience** — your configured client id, so a token minted for *another* application cannot be replayed here
- **expiry** (30s clock tolerance)
- the same `email_verified` + domain-allowlist policy as browser login (see [Email-verification trust assumption](#email-verification-trust-assumption))

**Trust model / documented tradeoff.** Unlike the browser flow there is no session to bind, so the OIDC `nonce` binding is intentionally dropped; trust rests on signature + issuer + audience + expiry + `email_verified`. That is the standard token-exchange model, and it is why the audience check (and a correctly scoped IdP app registration) carries the weight here.

**Provisioning fails closed.** JIT-provisioning from a token minted elsewhere is only allowed when `OIDC_ALLOWED_DOMAINS` bounds who may self-create. With auto-provision on and an empty allowlist, every exchange for an unknown email is refused with `no_account`, and the Settings page refuses to save that combination — otherwise any account at a public IdP (Google = the whole internet) could sign itself up and mint a bearer.

**Entra caveat (`preferred_username`).** Entra v2 tokens often omit `email` and carry the address in `preferred_username`, which is a directory attribute — in a tenant where guests or external identities can set their own mail attribute, a token can assert an address that matches an existing local account. Pinning `MS_TENANT_ID` to your own directory bounds that to identities your tenant admits; treat inviting a guest as granting whatever that email address owns here.

**Rate limiting.** The per-IP cap on this endpoint reads the client IP from `X-Forwarded-For`, so it is only a real cap behind a proxy that overwrites that header. Deploy accordingly — an internet-facing server with a pass-through header can be sprayed from a single host.

**Scope.** The minted bearer carries `scope: "mcp"`. That is a *route* allowlist, not a reduced permission set: it reaches `/index`, `/mcp`, and the ticket-eligible `/nests/:id/*` routes (including MCP write tools) with the user's full stewardship rights. Keep `MCP_TOKEN_TTL_SECONDS` short.

**Revocation.** Turning the master flag off stops *minting* but does not revoke bearers already issued — they remain valid until they expire (≤ 1h). Clear `MCP_SIGNING_SECRET` to invalidate every outstanding bearer at once.

Error codes returned by the endpoint: `disabled` (404), `rate_limited` (429), `bad_request`, `provider_disabled`, `provider_misconfigured` (400), `invalid_subject_token` (401), `email_not_verified`, `domain_not_allowed`, `no_account` (403), `server_error` (500).

---

## Database backends

The governance/auth metadata (users, sessions, nests registry, stewards, reviews, versions index, comments, telemetry) is stored in a relational database. Two backends are supported:

- **SQLite (default).** A single file at `DATABASE_PATH`. Zero-config, ideal for single-box and local deployments. Nothing changes for existing installs.
- **PostgreSQL / Cloud SQL.** For deployments where local disk isn't durable (e.g. Google Cloud Run, where the container filesystem is ephemeral). Selected by setting `DB_DRIVER=postgres`, `DATABASE_URL`, or `CLOUD_SQL_CONNECTION_NAME`.

On first connect the server creates its schema automatically (idempotent) — no manual migration step. There is no built-in SQLite→Postgres data migration; a new Postgres backend starts empty.

### First-boot upgrade passes

Some upgrades carry a one-shot data pass that runs at startup, before the server accepts requests, and records itself in `schema_migrations` so it never repeats. Two exist today: the `node_versions` backfill from `history.yaml`, and the version-chain repair added in 1.13 (re-anchors documents whose version chain was grafted by an older import, and moves inline patches into `v{N}.diff` files).

Both walk every document in every nest, so on a large vault the **first** boot after upgrading can take noticeably longer than usual — reads of the on-disk vault, not database work, so an install on network/FUSE storage feels it most. Every subsequent boot skips the pass entirely. Progress and a per-pass summary are printed to the server log.

> ⚠️ **Cloud Run durability — read this.** Cloud SQL persists only the *metadata
> database*. The actual **document content and version history** live on the
> filesystem under `$DATA_ROOT/nests/`, which on Cloud Run is **ephemeral** and is
> lost when an instance is recycled. Using Cloud SQL alone does **not** make a
> Cloud Run deployment fully durable. You must also put `$DATA_ROOT` on persistent,
> shared storage — e.g. mount a GCS bucket via Cloud Storage FUSE, or use a
> persistent volume — otherwise documents will disappear on redeploy/scale-in.

### Runtime settings persistence

Settings you change at runtime — everything on **Admin → Server settings** (`/admin/settings`: sign-in gate, logo, base URL, upload limit, feature flags, OIDC SSO, Slack/Teams/SMTP connectors) plus the **installed license key** — are stored in the database (`server_settings` table), **not** in a `.env` file. This is deliberate: on Cloud Run the container filesystem is ephemeral, so a file-based value was wiped by every rebuild, and each horizontally-scaled instance had its own filesystem, so a change on one never reached the others. The database (Cloud SQL in production) is durable **and** shared, so a UI change persists across rebuilds and is seen by every instance. Rows are loaded into the process environment at boot.

**Precedence between the deploy environment and a UI change.** Each stored row remembers the deploy-env value in effect when it was written. At boot:

- If the deploy env value for that key is **unchanged**, the stored UI change wins (your Settings-page edit survives an identical rebuild).
- If the deploy env value **changed** (you redeployed with a new value for that variable), the deploy env wins and the stored row is re-synced to it.

So you can always override any setting from the deploy config, while UI edits made to keys you don't set in the environment stay put. Clearing a setting in the UI writes a tombstone, so a value you removed is not resurrected from the environment on the next boot.

**Credentials are encrypted at rest.** The secret rows — `ANTHROPIC_API_KEY` (until it is handed over), `OIDC_CLIENT_SECRET`, `MCP_SIGNING_SECRET`, `SMTP_URL`, `SLACK_WEBHOOK_URL`, `MSTEAMS_WEBHOOK_URL`, `SES_SECRET_ACCESS_KEY`, `PROMPTOWL_KEY` — and every value in a nest's Tool environment (`nest_env`) are stored AES-256-GCM encrypted, so a row read in isolation is not the credential. Non-secret settings stay readable: what a server is configured to do is worth being able to see. One known exception: the license validation cache (`license_cache`) is still keyed by the license key itself.

The master key needs nothing configured: on first use the server generates one and stores it in the database (`server_settings`, key `SECRETS_MASTER_KEY`), so it survives redeploys, is shared by every instance, and travels with your database backups. That row is not a setting — it is never loaded into the process environment and never returned by the settings API.

Set **`SECRETS_KEY`** in the deploy environment to supply the key yourself instead; it takes precedence over the stored one, and any string works (it is hashed to 32 bytes). This is the stronger arrangement, because the key then lives somewhere the database is not: a database dump alone cannot open the values. With the stored key, a dump that includes that row includes the key — the encryption protects against a value being read or logged incidentally, not against an attacker holding the whole database. If you set `SECRETS_KEY` on a server that already wrote values under the stored key, it cannot read them: the server still boots, logs which settings it could not open, and treats each as unset so an admin can re-enter it.

Values written before any of this existed are read back as plaintext and re-encrypted the next time they are saved — nothing to migrate.

### Cloud Run + Cloud SQL (PostgreSQL)

Attach the Cloud SQL instance to the service (`--add-cloudsql-instances`) so the Auth Proxy unix socket appears at `/cloudsql/<connection-name>`, then:

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

Or with a plain TCP connection string (e.g. the Cloud SQL Proxy running on localhost, or a private IP):

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

Terminate TLS at the proxy and set `HOST=127.0.0.1` and `TRUSTED_PROXIES=loopback` so only the proxy can reach the server and only its forwarded headers count. Details in [Reverse proxies](#reverse-proxies).

### Reverse proxies

The server reads three forwarded headers: `X-Forwarded-For` / `X-Real-IP` (the client IP that per-IP rate limits on sign-in are keyed on) and `X-Forwarded-Proto` (whether session cookies get `Secure`). A header is only as trustworthy as whoever set it, so tell the server which peers are proxies:

| Topology | Settings |
|---|---|
| Proxy on the same host (nginx, Caddy, Traefik) | `HOST=127.0.0.1`, `TRUSTED_PROXIES=loopback` |
| Proxy or load balancer elsewhere on a private network | `TRUSTED_PROXIES=10.0.0.0/8` (its subnet), or `private` for every RFC 1918 / CGNAT / link-local range |
| Exposed directly, no proxy | `TRUSTED_PROXIES=loopback` — forwarded headers from the internet are then ignored |
| Cloud Run | Leave unset. Google's front end sets the headers and its peer addresses aren't stable. |

The proxy must **overwrite** the headers rather than pass client values through, and must forward `Host` unchanged or you must set `PUBLIC_BASE_URL` (see the env reference). If your proxy sets only `X-Real-IP` (a common nginx snippet), also set `X-Forwarded-For` to the same value — otherwise a client can send its own `X-Forwarded-For` and choose the IP its rate limit is keyed on. nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:3838;
  proxy_set_header Host              $host;
  proxy_set_header X-Forwarded-For   $remote_addr;
  proxy_set_header X-Real-IP         $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_http_version 1.1;            # MCP streams over HTTP/1.1
  proxy_buffering off;
}
```

Caddy sets these headers itself: `reverse_proxy 127.0.0.1:3838`.

With port forwarding (router or firewall NAT), forward the public `443` to the **proxy**, never the server's `3838` directly — `3838` speaks plain HTTP.

### Public docs site behind the owner's proxy (`public_url`)

A nest owner can serve their docs site under a path on their own domain, for example `https://example.com/docs`. They set `public_url` in **Public site → Advanced** and prove the host with a DNS TXT record.

1. Proxy `https://example.com/docs/*` to `https://<this server>/d/<key>/*`.
2. Make the proxy **set** `X-Forwarded-Host: example.com` on every request. Overwrite any value the client sent; do not pass it through.

The server serves a request through the proxy only when `X-Forwarded-Host` equals the `public_url` host. Every other request gets a `301` to the `public_url`. Anyone can send that header straight to this server and get the page, but the page is public and its links and canonical always name the `public_url`. Both answers carry `Vary: X-Forwarded-Host`.

> **Caution:** a shared cache in front of this server that ignores `Vary` can store a `200` where a `301` belongs, or the opposite. Key such a cache on `X-Forwarded-Host`, or do not cache `/d/*` there.

**Shutoff timing.** When a nest goes private or Reader Mode goes off, the instance that took the change stops serving its site at once. Other instances stop within 5 seconds (the site-list cache). The host-to-nest cache for custom domains is 30 seconds, but it only says which nest a host names, never that the nest is still public.

### Corporate egress proxy

When outbound traffic must go through a proxy, set in the process environment (Docker `-e`, a systemd `Environment=` line, or your shell — **not** `.env`, which loads after Node has configured networking):

```bash
HTTPS_PROXY=http://proxy.corp.example:3128
HTTP_PROXY=http://proxy.corp.example:3128
NO_PROXY=localhost,127.0.0.1,.corp.example
NODE_USE_ENV_PROXY=1          # already set in the Docker image
NODE_EXTRA_CA_CERTS=/etc/ssl/corp-root-ca.pem   # only if the proxy inspects TLS
```

Startup logs the proxy in use (credentials masked), or says why a configured proxy is not being used. Everything the server fetches over HTTP(S) goes through it, with these exceptions, which connect **directly**:

- SMTP (nodemailer opens its own TCP connection) and PostgreSQL.
- AWS SES, which goes through the AWS SDK's HTTP client.
- **Metacognition agent feeds and MCP servers — on purpose.** Those URLs come from agent configuration, so the server resolves each host itself and refuses private addresses (`169.254.169.254`, `10.x`, …) at connect time. Through a proxy, the proxy would do the resolving and that check would never run. If your network only allows egress via the proxy, these agent fetches fail closed rather than bypass the check.

Give those direct egress, or put them on a path the firewall allows.

Outbound destinations to allow, through the proxy or the firewall:

| Destination | Port | Used for | Configured by |
|---|---|---|---|
| `app.promptowl.ai` | 443 | License validation, PromptOwl sign-in (device flow), teams import, own-model keys, telemetry ingest | `PROMPTOWL_API_URL` |
| The model gateway host sent with your license, else `api.anthropic.com` | 443 | Hootie and other model calls | License / nest model settings |
| Your IdP (e.g. `login.microsoftonline.com`) | 443 | OIDC discovery, keys and token exchange | `OIDC_ISSUER` |
| Your Slack / Teams webhook hosts | 443 | Notifications | Settings → Notifications |
| `us.i.posthog.com` | 443 | Product analytics, when telemetry is on | `POSTHOG_HOST` |
| Your SMTP server | 25 / 465 / 587 | Email notifications — **direct, not proxied** | `SMTP_URL` |
| Your PostgreSQL server | 5432 | Database, when not SQLite — **direct, not proxied** | `DATABASE_URL` / `DB_HOST` |
| Hosts your metacognition agents read (feeds, MCP servers) | 443 | Agent research — **direct, never proxied** (SSRF check) | Agent configuration |

### Hosted / commercial SaaS

Same as team, plus:
- Run N instances behind a load balancer. SQLite + a shared filesystem is not a great long-term story for the metadata DB when scaling beyond one box — switch to the **PostgreSQL / Cloud SQL** backend (see [Database backends](#database-backends)) so all instances share one consistent database. The on-disk nest vault under `$DATA_ROOT/nests/` still needs durable shared storage.
- Set `TELEMETRY_ENABLED=true` and a valid `PROMPTOWL_KEY` so usage rolls up to PromptOwl.
- Rotate keys regularly via `DELETE /auth/keys/:id` + `POST /auth/keys`.

## Firewalls, VPNs and tunnels

**Server settings → Network & status** runs these checks for you and shows the values for your server. It has a status checklist (database, disk, license, public address, email, SSO, scheduler), an inbound check of the public address, an outbound test of every host the server calls, and the deployment recipes below.

### Who connects to whom

| Direction | Who | Needs |
|---|---|---|
| Inbound | People's browsers, Claude Code, Claude Desktop (local config), the `ctx` CLI | Reach the server from their machine. A VPN works. |
| Inbound | Hosted connectors: claude.ai, ChatGPT, Claude Desktop/Cowork *connectors* | A **public** DNS name with a **publicly trusted** certificate. They connect from the vendor's servers, not your VPN. |
| Outbound | This server | HTTPS to PromptOwl (`PROMPTOWL_API_URL`, licensing and PromptOwl sign-in), the license's model gateway, your OIDC issuer, Slack/Teams webhooks, PostHog when telemetry is on; SMTP or SES for email; your Postgres host. The exact list for your settings is on the Network & status tab (**Copy allowlist**). |

### Public with HTTPS

Point a DNS name at the server, terminate TLS in front of it with a publicly trusted certificate, open only 443 inbound, and set `PUBLIC_BASE_URL` (or **Settings → Basic → Public base URL**) to `https://<name>`. Don't expose the app's own port (`PORT`, default 3838) to the internet.

### Behind a reverse proxy

A full TLS server block. Which forwarded headers the app trusts (`HOST`, `TRUSTED_PROXIES`) is covered in [Reverse proxies](#reverse-proxies).

```nginx
server {
    listen 443 ssl;
    server_name nest.example.com;
    ssl_certificate     /etc/letsencrypt/live/nest.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nest.example.com/privkey.pem;
    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:3838;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_buffering off;       # MCP streams responses
        proxy_read_timeout 300s;
    }
}
```

```caddyfile
nest.example.com {
    reverse_proxy 127.0.0.1:3838 {
        flush_interval -1
    }
}
```

Caddy obtains the certificate, sets `X-Forwarded-Proto`, and replaces any client-supplied `X-Forwarded-For` by default.

### VPN-only

Browsers, Claude Code, local Desktop configs and the CLI work over the VPN. Hosted connectors don't: they can't reach a private address. To support them anyway, either publish only `/mcp`, `/.well-known/*` and `/oauth/*` on a public name and allow inbound traffic only from [Anthropic's published IP ranges](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), or use a tunnel scoped to those paths (below). The Connect dialog warns users when the server's address is private.

### NAT and port forwarding

Give the server a fixed LAN address, forward TCP 443 (and 80 if your proxy gets certificates over HTTP-01) to the reverse proxy on that machine, and use dynamic DNS if your public IP changes. Never forward straight to the app's port: it has no TLS of its own. If the inbound check fails from inside your network but the address works from outside (for example a phone on mobile data), the router doesn't support hairpin NAT — use split DNS internally.

### Tunnels

A tunnel agent (Cloudflare Tunnel, ngrok, Tailscale Funnel) connects out, so no inbound port is opened. Expose only what you need — for hosted connectors, `/mcp`, `/.well-known/*`, `/oauth/*` and `/health` — then set `PUBLIC_BASE_URL` to the tunnel's address.

```yaml
# cloudflared config.yml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: nest.example.com
    path: ^/(mcp|\.well-known/|oauth/|health$)
    service: http://localhost:3838
  - service: http_status:404
```

`ngrok http 3838 --url=<your-domain>` and `tailscale funnel --bg 3838` expose the whole app; add path rules in front if only the connector paths should be public.

### Behind an egress proxy

Set it up as in [Corporate egress proxy](#corporate-egress-proxy), then run **Test connections** on the Network & status tab: with a proxy set, HTTPS targets are tested through it.

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

## Message log and privacy

Superadmins can read the message log at **Admin → Message log**. It holds every message this server sent, across every nest, including the text of notifications and agent comments about documents the superadmin may never have opened.

That is the point of it: one place to see what people and agents were told. But it is also a second copy of message content. It is controlled like this:

- **Superadmin only.** The log is never available in open mode, or to nest owners or nest admins.
- **Every read is audited.** Listing, opening a message, and viewing the audit itself each write a `message_log_views` row. That row is kept for 365 days, longer than the messages it covers.
- **Secrets never reach it.** Temporary passwords, sign-in tokens, API and hook keys, Bearer tokens and webhook URLs are redacted before the row is written. Bodies are capped at 4 KB.
- **Retention.** `MESSAGE_LOG_RETENTION_DAYS` (default 30) bounds how long message content lives. Database backups taken within that window will contain it.
- **Metadata-only mode.** `MESSAGE_LOG_STORE_BODIES=false` keeps who, when, where and delivery status, but no body. The subject (often a document title), recipients and any delivery error text are still kept, redacted. Use this where a second copy of message content is not acceptable.

