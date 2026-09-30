# ContextNest Community Edition

**Self-hosted context governance server for AI workflows.** Part of the [PromptOwl](https://promptowl.ai) platform.

> ⚠️ **Commercial Software.** ContextNest Community Edition is proprietary software licensed by Promptowl LLC. A free [PromptOwl account](https://app.promptowl.ai) is required to use it. Redistribution, hosting-as-a-service, and competitive use are prohibited. See [LICENSE.md](./LICENSE.md) for full terms.

---

## What it is

A shared knowledge base for your team **and** your AI agents, running on your own machine or infrastructure. Documents live in **nests**; every save is a version; in a stewarded nest a change waits for a reviewer before agents can read it. People write in the browser, agents read and write the same documents over MCP, HTTP or the `ctx` CLI.

Concretely, it lets you:

- Write Markdown documents — plus hosted HTML artifacts and CSV tables agents can query row by row — filed in folders, linked with `[[Title]]`, tagged, commented on, and versioned
- Import an existing folder of Markdown in one step; export a nest as a portable bundle
- Govern changes — draft → pending review → approved — with stewards per nest, tag or document, and a cross-nest inbox (My Work, My Drafts) for what is waiting on you
- Share a nest with people or teams, share a single document or folder, or publish read-only to the public
- Give agents deterministic reads: the same selector returns the same context every time, with a trace of what was pulled
- Run agents against a nest (Workflows, Beta): an agent is a document whose body is instructions; its output lands as a pending review
- Sync with the PromptOwl hosted platform for accounts, licensing and teams

Your PromptOwl account handles authentication, entitlement, and governance metadata.

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

## First five minutes

1. **Create a nest** on the Nests page — or **Import folder** to bring in Markdown you already have.
2. **Write a document.** `[[Title]]` links another document, `@name` mentions a person, tags go under the title. Every save is a version.
3. **Turn on stewardship** (nest Settings) if you want review. Saves become drafts; **Submit for review**; a steward approves or rejects. Alone? Allow self-approve and you get the history without the ceremony.
4. **Connect an agent.** Inside a nest, **Connect** (bottom of the sidebar) gives you the MCP URL and a REST snippet; **Add with AI** (nest overview) is a prompt that has an agent write context in. Mint a key under Workspace → API keys.
5. **Share.** The whole nest with a person or team, one document or folder, or make it public with a read-only Reader mode.

The in-app **How it works** page (sidebar → Help) is the full tour; **Docs** (header) is the agent manual.

## Around the app

One sidebar, grouped:

| Group | Pages | Who |
|---|---|---|
| — | **Nests** — every nest you can see, pinned first | everyone |
| Work | **My Work** (reviews and handoffs waiting on you, across nests) · **My Drafts** (yours, never submitted) | everyone |
| Workspace | **Teams** · **API keys** | everyone |
| Admin | **Teammates** · **Server settings** · **Activity trace** | server admins |
| Help | **How it works** | everyone |

Inside a nest: the document tree, plus **Board** (documents as cards by folder, status or tag), **Graph** (documents, links, tags, stewards), **Definitions** (the nest's glossary) and **Workflows** (Beta). The user menu (top right) holds **Account** (name, password), keyboard shortcuts and logout. `Ctrl`/`⌘` `K` searches every nest and document; `?` lists shortcuts.

## Connect an agent

Point any agent at `<server>/llms.txt` — it is the complete manual (endpoints, MCP tools, selector grammar). The short version:

- **MCP** — `<server>/mcp` for everything the key can read, `<server>/nests/<id>/mcp` for one nest with the full toolset. Claude Code, Cursor and VS Code connect over HTTP with `Authorization: Bearer cnst_…`; Claude Desktop goes through `npx -y mcp-remote`.
- **REST** — `POST /nests/<id>/context` with a selector (`#tag`, `[[Title]]`, `type:document`, combined with `+ | -`) returns assembled context plus a trace. Full reference: [API.md](./API.md).
- **ctx CLI** — `ctx vault add <alias> --url <server>/nests/<id>/mcp --bearer-env CONTEXTNEST_API_KEY`, then `ctx query "#tag" --vault <alias>`.

Keys are minted in the app (Workspace → API keys, or the Connect dialog) — one per client, user-wide or scoped to a nest. Servers in `AUTH_MODE=open` need none.

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
| Export nest as portable bundle (.zip) | ✅ | ✅ |
| Markdown rendering + wiki cross-linking | ✅ | ✅ |
| External-edit detection + version diff | ✅ | ✅ |
| Stewardship workflow (draft/review/approve) | ✅ | ✅ |
| Per-nest sharing + collaborators | ✅ | ✅ |
| Public read-only nests | ✅ | ✅ |
| Custom logo / branding | ✅ | ✅ |
| Admin password reset + user removal (in-platform) | ✅ | ✅ |
| Wiki backlinks, outline, hover-preview, link health | ✅ | ✅ |
| Rich editor — tables, callouts, toggles, code highlight, find/replace, image & video upload, YouTube / Vimeo embeds | ✅ | ✅ |
| Folder organization — nested folders, move documents, lazy folder tree | ✅ | ✅ |
| Scales to large vaults — nest listings served from a document index, not a disk crawl | ✅ | ✅ |
| Steward version revert | ✅ | ✅ |
| MCP server for AI agents | ✅ | ✅ |
| One-shot agent setup — generated connect prompt + `.env` download | ✅ | ✅ |
| Several API keys per account — one credential per client, rotate one at a time | ✅ | ✅ |
| Comments on documents — anchored threads, resolve / reopen, same threads over MCP | ✅ | ✅ |
| Table nodes — CSV facts with deterministic row queries (`POST /table-query`, `context_table_query`) | ✅ | ✅ |
| Teams — share a nest with a group once; import rosters from PromptOwl | ✅ | ✅ |
| Cross-nest inbox — My Work (reviews, handoffs) and My Drafts | ✅ | ✅ |
| Nest views — Board (kanban by folder / status / tag), Graph, Definitions glossary | ✅ | ✅ |
| Workflow plane (Beta) — agents as documents, runs, schedules, inbound hooks, Slack / Teams / webhook connectors | ✅ | ✅ |
| Activity trace — every governance action, per nest and server-wide | ✅ | ✅ |
| Notifications — Slack, Microsoft Teams, email | ✅ | ✅ |
| Centralized multi-tenant admin console | — | ✅ |
| Single sign-on (OIDC — Entra ID, Google, Okta, Keycloak) — [admin guide](./CONFIGURATION.md#single-sign-on-oidc) | ✅ | ✅ |
| SAML / SCIM provisioning | — | ✅ |
| Audit log streaming | — | ✅ |
| Policy transforms (redaction, summarization) | — | ✅ |
| Priority support and SLA | — | ✅ |

For Enterprise pricing and features, contact **hoot@promptowl.ai** or visit <https://promptowl.ai/contextnest/>.

## What's new

**Next release (unreleased)**

- **Hootie is a side panel now, and off by default.** It opens from a slim tab on the right edge and slides in beside the page: on wide screens it pushes the page over instead of covering it, and you can drag its left edge to resize it (the width is remembered). Existing servers that never switched it on explicitly will find it **off** after upgrading; turn it on under Settings → General, or set `HOOTIE_ENABLED=true`.
- **Custom assistant name and branding (Enterprise).** Admins can rename Hootie and give it a logo, accent colour and greeting under Settings → General. The name also goes into the assistant's instructions and the comments it posts. Without an Enterprise licence everyone sees Hootie, and the server refuses the settings.

Full release notes live in [CHANGELOG.md](./CHANGELOG.md).

## Documentation

- [CONFIGURATION.md](./CONFIGURATION.md) — every environment variable (port, auth mode, storage, notifications, telemetry)
- [Single sign-on admin guide](./CONFIGURATION.md#single-sign-on-oidc) — connect Microsoft Entra ID, Google, Okta, Keycloak or any OIDC provider; what happens to existing accounts, API keys and agents; every `sso_error` code with its fix
- [API.md](./API.md) — complete REST reference with request and response bodies
- [STEWARDSHIP.md](./STEWARDSHIP.md) — the governance model: modes, stewards, scopes, prime documents, teams, super-admins
- `<server>/llms.txt` — the agent manual the running server publishes; rendered as **Docs** in the app
- **How it works** inside the app — a page-by-page tour

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
