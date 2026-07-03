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
| `PROMPTOWL_KEY` | `""` | Your PromptOwl Community License key (`pk_...`). Unlicensed instances still run and serve reads, but every write returns `503` until a valid key is installed. Can also be set via the browser License Setup Page, which persists it to `ENV_FILE_PATH`. |
| `PROMPTOWL_SIGN_IN_GATE` | `open` | Restrict "Sign in with PromptOwl". `open` = anyone may; `admin-only` = only the license owner (admin) may, everyone else uses email/password (admin opens the login page with `?admin=1`); `disabled` = nobody may. Enforced server-side at `POST /auth/promptowl` and surfaced on the health endpoint. Unknown values fall back to `open`. |
| `OFFICIAL_COMMUNITY_SSO_SECRET` | `""` | **Official deployment only — leave unset on self-hosted.** Shared HMAC secret enabling the one-click "Open Community" SSO auto-login from PromptOwl. Must exactly match the same-named var on PromptOwl. When unset, `GET /auth/sso` returns `404` and the feature is disabled; self-hosted users keep using the manual device-code flow. |
| `PUBLIC_BASE_URL` | `""` | This server's canonical external URL (e.g. `https://community.promptowl.ai`). Checked against the SSO ticket's `aud` claim so a ticket minted for this server can't be replayed against another. Only relevant when `OFFICIAL_COMMUNITY_SSO_SECRET` is set; when unset, the audience check is skipped. |
| `ENV_FILE_PATH` | `$DATA_ROOT/.env` | Path to the `.env` file the license install flow writes `PROMPTOWL_KEY` into (alongside existing vars), and which the server also reads at boot. Defaults **under `DATA_ROOT`** so the browser License Setup Page persists durably in containers — `$cwd` is `/app` in the official image (root-owned, discarded on container recreate), which silently lost the key. Override only if your writable, persisted `.env` lives elsewhere. In containers, providing `PROMPTOWL_KEY` directly via the environment also works and is read at boot. |
| `TELEMETRY_ENABLED` | `"true"` (set to `"false"` to disable) | Batched, anonymized usage events sent to PromptOwl. Off disables the loop entirely. |
| `TELEMETRY_INTERVAL_MS` | `3600000` (1 hour) | How often buffered telemetry is flushed to PromptOwl. |
| `CORS_ORIGINS` | `*` in open mode; `http://localhost:5173,http://localhost:3838` in key mode | Comma-separated allowlist. Set to `*` to allow any origin (**only** safe in open mode — in key mode with Bearer tokens this enables CSRF). |
| `MAX_BODY_BYTES` | `10485760` (10 MB) | Reject requests whose `Content-Length` exceeds this. Prevents giant-payload DoS. |
| `LOGO_URL` | _(unset)_ | Custom logo shown in the UI header + login screen. Must start with `https://`, `http://`, or `data:image/` — other schemes (`file://`, relative, `javascript:`) are rejected with a warning and the bundled icon is used. |
| `SLACK_WEBHOOK_URL` | _(unset — connector off)_ | Slack incoming-webhook URL for governance-event notifications (review submitted/approved/rejected, collaborator added). `https://` only — the URL embeds a secret. Also editable from Settings in the UI. |

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
