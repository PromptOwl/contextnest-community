# ContextNest Community Edition

**Self-hosted context governance server for AI workflows.** Part of the [PromptOwl](https://promptowl.ai) platform.

> ⚠️ **Commercial Software.** ContextNest Community Edition is proprietary software licensed by Promptowl LLC. A free [PromptOwl account](https://app.promptowl.ai) is required to use it. Redistribution, hosting-as-a-service, and competitive use are prohibited. See [LICENSE.md](./LICENSE.md) for full terms.

---

## What it is

ContextNest Community Edition is a self-hosted server that lets you:

- Store, version, and govern markdown-based context documents ("nests")
- Import an existing folder or vault of markdown files in one step
- Apply stewardship workflows — draft, pending review, approved
- Share nests with collaborators or publish them read-only to the public
- Serve approved context to AI agents via MCP, HTTP, or CLI
- Sync with the PromptOwl hosted platform for multi-user collaboration

The server runs locally or on your own infrastructure. Your PromptOwl account handles authentication, entitlement, and governance metadata.

## Quickstart

```bash
# 1. Run the community server
npx @promptowl/contextnest-community

# 2. Open the server in your browser
#    http://localhost:3838
#    On first boot with no license, it lands on the License Setup Page.

# 3. Paste your PromptOwl license key (pk_...) — see "License setup" below
```

The server listens on `http://localhost:3838` by default. Without a valid license the server still runs and serves reads, but write actions return `503` until you activate. See [CONFIGURATION.md](./CONFIGURATION.md) for all environment variables (port, auth mode, storage, telemetry).

> **Optional:** scaffold a local nest with the open-source CLI before connecting:
> ```bash
> npx @promptowl/contextnest-cli init
> ```

## License setup

ContextNest Community Edition requires a PromptOwl Community License key (`pk_...`). Getting and activating one:

### 1. Create the key (free)

1. Sign up or log in at <https://app.promptowl.ai>
2. Open the **Overview** menu → **Community License**
3. Click **Create a Community License key**
4. Copy the generated key — it starts with `pk_`

### 2. Activate the server

Pick **one** of two ways:

**A. Browser setup page (recommended for first run)**

1. Start the server: `npx @promptowl/contextnest-community`
2. Open <http://localhost:3838> — with no license installed, the server boots into **setup mode** and shows the **License Setup Page**
3. Paste your `pk_...` key and submit
4. The server validates it against PromptOwl, writes it to your `.env`, and exits setup mode — no restart needed

**B. Environment variable (recommended for Docker / CI / scripted deploys)**

```bash
PROMPTOWL_KEY=pk_... npx @promptowl/contextnest-community
```

The key is read at boot. The server validates against PromptOwl on startup; if valid, it goes straight into licensed mode.

### 3. How licensing behaves at runtime

- **Unlicensed / setup mode** — reads work; every non-GET (write) request returns `503` until a valid key is installed.
- **Live revocation** — a long-poll watcher tracks license state against PromptOwl. If your key is revoked, the server blocks writes within seconds (no restart required) and returns to setup mode.
- **Admin identity follows the license** — the admin user is whichever PromptOwl account owns the installed key, resolved live per request. Transferring the license to another account immediately promotes the new owner and demotes the old one.

For redistribution, hosted-service, OEM, or regulated-industry licensing, contact **hoot@promptowl.ai**.

## System requirements

- **Node.js** 20.x or later
- **PromptOwl account** — free signup at <https://app.promptowl.ai/signup>
- **OS:** Windows, macOS, or Linux
- **Disk:** ~200 MB for the server, plus storage for your nests

## What you get

| Feature | Community Edition | Enterprise |
|---|:---:|:---:|
| Self-hosted context server | ✅ | ✅ |
| SQLite or PostgreSQL / Cloud SQL backend | ✅ | ✅ |
| Configurable nest storage (external / GCS volume mount) | ✅ | ✅ |
| Markdown + YAML frontmatter vaults | ✅ | ✅ |
| Import existing folder / vault | ✅ | ✅ |
| Markdown rendering + wiki cross-linking | ✅ | ✅ |
| External-edit detection + version diff | ✅ | ✅ |
| Stewardship workflow (draft/review/approve) | ✅ | ✅ |
| Per-nest sharing + collaborators | ✅ | ✅ |
| Public read-only nests | ✅ | ✅ |
| Custom logo / branding | ✅ | ✅ |
| Admin password reset + user removal (in-platform) | ✅ | ✅ |
| Wiki backlinks, outline, hover-preview, link health | ✅ | ✅ |
| Rich editor — tables, callouts, toggles, code highlight, find/replace | ✅ | ✅ |
| Steward version revert | ✅ | ✅ |
| MCP server for AI agents | ✅ | ✅ |
| Centralized multi-tenant admin console | — | ✅ |
| Single sign-on (OIDC — Entra ID, Google, Okta, Keycloak) | ✅ | ✅ |
| SAML / SCIM provisioning | — | ✅ |
| Audit log streaming | — | ✅ |
| Policy transforms (redaction, summarization) | — | ✅ |
| Priority support and SLA | — | ✅ |

For Enterprise pricing and features, contact **hoot@promptowl.ai** or visit <https://promptowl.ai/contextnest/>.

## What's new in 1.6.0

- **PostgreSQL / Cloud SQL backend** — run the server on PostgreSQL alongside SQLite via an async DB adapter, so metadata survives on Cloud Run and other deployments where local disk isn't durable. Supports the Cloud SQL Auth Proxy (unix socket) and TCP + TLS. New `DB_*` env vars (`DB_DRIVER`, `DATABASE_URL`, `CLOUD_SQL_CONNECTION_NAME`, `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`, `DB_POOL_MAX`, `DB_SSL`, `DB_SSL_CA`); SQLite stays the default when nothing is configured. See [CONFIGURATION.md](./CONFIGURATION.md).
- **Configurable `NEST_STORAGE_ROOT`** — store nest vault files (markdown + version history) outside `DATA_ROOT` — e.g. on a Cloud Storage (GCS) volume mount — while the database stays on `DATA_ROOT`. Defaults to `<DATA_ROOT>/nests`, so existing deployments are unchanged. On a GCS FUSE mount, set `DRIFT_SCAN_INTERVAL_MS=0` and run a single instance.
- **Security fix** — the admin guard on `/admin/settings` (GET/PATCH) is now correctly awaited; without it a non-admin could read or change server-wide settings in key mode.
- **AdminLoginModal respects `PROMPTOWL_SIGN_IN_GATE`** — the "Sign in with PromptOwl" affordance follows the configured gate (`open` / `admin-only` / `disabled`).
- **Drift scanner toggle** — `DRIFT_SCAN_INTERVAL_MS=0` now actually disables the drift scanner (previously reset to the 30s default).
- **Safer folder sync** — unsynced-folder detection no longer treats a configured nest storage root as a sync candidate, preventing accidental duplication/removal of live nests when `NEST_STORAGE_ROOT` is nested under `DATA_ROOT`.

Full history in [CHANGELOG.md](./CHANGELOG.md).

## What's new in 1.3.0

- **Server super-admins** — emails listed in `access.yaml: super_admins` administer every nest (change visibility, manage collaborators and stewards) without being added per-nest. Owner-only operations (delete, transfer) still require the nest owner. See [STEWARDSHIP.md](./STEWARDSHIP.md).
- **License persistence under `DATA_ROOT`** — `PROMPTOWL_KEY` now writes to `$DATA_ROOT/.env` (was `$cwd/.env`, which is root-owned `/app` in the official Docker image and silently lost the key on container recreate). The License Setup Page also surfaces write failures instead of failing quietly. Override via `ENV_FILE_PATH`. See [CONFIGURATION.md](./CONFIGURATION.md).
- **Case-insensitive email** across registration, login, invite, and access checks. Migration dedupes existing accounts that differ only in case; fixes "I can't log in because I capitalized my email" and access-guard / lockout mismatches.
- **Document version history + inline diff** — every saved version is browsable in the document detail view, and an inline diff highlights what changed between any two versions.
- **Nest Overview / index landing** — every nest opens on a grouped table-of-contents with a "recently edited" strip instead of a flat list.
- **Public/private toggle on the nest header** — visibility is set directly from the header, not buried in a dialog.
- **Review queue surfaces submitted-for-review edits** — reviewers see the pending versions a contributor staged, not just net-new documents.
- **Internal-folder sync over MCP** — agents can list a nest's unsynced filesystem folders and pull them into the nest on demand. New `unsynced-service.ts` + MCP tools, covered by `test/unsynced-folder.test.ts` and `test/mcp-unsynced.test.ts`.
- **Telemetry `batch_id` + user email** — usage events carry a stable `batch_id` (de-duped on the receiver) and the authenticated user email alongside the user id, so the PromptOwl ingest bridge can meter credits to the right account.
- **Hyperlink navigation fix** — hyperlinks in the editor and viewer navigate to their configured target URL correctly.
- **Repo / DX** — `CLAUDE.md` at the repo root with project-specific guidance for Claude Code; `claude.yml` (PR assistant) and `claude-code-review.yml` (auto review on PRs) GitHub Actions workflows.

Full history in [CHANGELOG.md](./CHANGELOG.md).

## What's new in 1.2.0

- **Admin user management (no email server needed)** — `POST /auth/admin/reset-password/:userId` sets a user's password or returns a one-time temp password; `DELETE /auth/users/:userId` removes a user and revokes their API keys, sessions, and role rows. New self-service **Change password** in the user menu blocks reusing the current password.
- **`PROMPTOWL_SIGN_IN_GATE`** — `open` / `admin-only` / `disabled` restricts "Sign in with PromptOwl" (admin reaches it via `?admin=1`). See [CONFIGURATION.md](./CONFIGURATION.md).
- **Plain-text agent view** — `?format=markdown` on a node returns frontmatter + body as `text/markdown` for LLM-friendly consumption.
- **Steward version revert** — `POST .../revert` restores an earlier version as a new one; pending-review docs are now editable (saving withdraws the review).
- **Editor — always-editable surface** — Notion-style buttery headline, selection bubble toolbar (format-on-highlight), turn-into block conversion, Cmd+F find & replace, rich blocks (tables, callouts, toggles, syntax-highlighted code, columns), and wiki/code-safety fixes.
- **Wiki usability** — backlinks panel ("Linked from N documents"), outline/TOC for 3+-heading docs, hover-preview on `[[wiki links]]`, multi-tag AND filtering with clickable chips, per-doc copy link, rename-safety warning for title-form links, link-health report (broken links + orphans), recently-edited strip.
- **Sharing clarity** — share button reads "Share nest"; dialog clarifies nest-wide scope; deep links open documents directly.
- **Security** — hardened scanner gate (PolinRider + Shai-Hulud preflight) in `bin/`.

Full history in [CHANGELOG.md](./CHANGELOG.md).

## What's new in 1.1.0

- **Vault import** — import an existing folder of markdown files into a new nest in one step, from the dashboard ("Import folder") or via the API. Frontmatter, wiki links, and folder structure are preserved.
- **Nest sharing + collaborators** — set per-nest visibility and add collaborators with read or write access. A Share affordance is now inline in the document view.
- **Public read-only nests** — flip a nest to `visibility=public` to serve it to unauthenticated readers (bypasses auth for GETs only); writes still require a key.
- **Custom logo / branding** — set `LOGO_URL` to show your own logo in the UI header and login screen. See [CONFIGURATION.md](./CONFIGURATION.md).
- **Governance** — nest owners can self-approve their own changes; new per-nest auto-approve toggle; role-based action gating (buttons reflect the viewer's role); stewards can edit scope during a role change.
- **Editor** — `[[wikilink]]` autocomplete, broken-link click creates a new doc with the title pre-filled, tag chips filter the nest list, Notion-style H1 title, click-to-edit, and an unsaved-changes warning.
- **Stability** — added an error boundary so a render error in one view no longer blanks the whole app; bumped `uuid` to 14.

Full history in [CHANGELOG.md](./CHANGELOG.md).

## What's new in 1.0.1

- **Document hashing pipeline** — external-edit detection, conflict-aware safe-publish, and inline version diffs powered by `@promptowl/contextnest-engine`. When a file is edited outside the UI, the editor shows an "External edit detected" banner with a side-by-side diff and an adopt / keep choice.
- **Markdown rendering** — new `DocumentViewer` (react-markdown + remark-gfm + wikilink support) renders CLI/MCP-authored markdown correctly, with a view/edit toggle.
- **License revocation now blocks writes synchronously** — revoke flips an in-process "writes blocked" flag immediately; the next write returns `503`.
- **Dashboard stats** — new `GET /stats` endpoint surfaces nest / document / user counts.
- **Docker fix** — Dockerfile now installs via npm against the shipped `package-lock.json`; base image bumped to `node:22-slim`.

Full history in [CHANGELOG.md](./CHANGELOG.md).

## Licensing

ContextNest Community Edition is **commercial software**. It is **not open source**.

**You may:**
- Install and run the Software on devices You own or control
- Use the Software for internal business purposes, tied to a valid PromptOwl account
- Make backup and archival copies

**You may not:**
- Redistribute, resell, rent, lease, or sublicense the Software
- Offer the Software as a hosted, managed, or software-as-a-service product to third parties
- Reverse engineer, decompile, or create derivative works
- Use the Software to build a competing product or service
- Remove copyright, trademark, or license notices

Full license text: [LICENSE.md](./LICENSE.md)

**For redistribution, hosted-service, OEM, or regulated-industry use,** contact **hoot@promptowl.ai** for a commercial license agreement.

## Platform terms

Because the Software requires a PromptOwl account, the following terms also apply to Your use:

- **End User License Agreement** — <https://promptowl.ai/eula/>
- **Terms of Service** — <https://promptowl.ai/terms-of-service/>
- **Privacy Policy** — <https://promptowl.ai/privacy-policy/>
- **Acceptable Use Policy** — <https://promptowl.ai/acceptable-use/>
- **Disclaimer** — <https://promptowl.ai/disclaimer/>
- **Cookie Policy** — <https://promptowl.ai/cookies/>

## Support

- **Documentation:** <https://promptowl.ai/contextnest/>
- **Product questions:** <https://promptowl.ai/contact-us/>
- **Support & bugs:** `hoot@promptowl.ai`
- **Commercial licensing:** `hoot@promptowl.ai` (subject: *ContextNest Commercial License*)

## AI output disclaimer

The Software injects content into large language models. AI output may be inaccurate, incomplete, or inappropriate for your use case. You are responsible for reviewing and validating any AI-generated content before relying on it, particularly in business-critical or regulated contexts. Do not deploy the Software in medical, legal, financial-advisory, or safety-critical environments without appropriate human oversight.

---

**Copyright © 2026 Promptowl LLC.** All rights reserved.
"ContextNest" and "PromptOwl" are trademarks of Promptowl LLC.

Promptowl LLC · 3060 Mercer University Dr Ste 110 · Atlanta, GA 30341 · USA
