# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ContextNest Community Edition is a self-hosted context governance server for AI workflows, part of the ContextNest ecosystem in the PromptOwl GitHub organization. It enables organizations to deploy their own context governance infrastructure with full stewardship workflows already configured.


## Engine Logic Boundary

**Base/core engine logic must NOT be added to this repo.** Anything fundamental to the engine — core versioning, hashing, prompt compilation — belongs in the upstream ContextNest engine package ([PromptOwl/ContextNest](https://github.com/PromptOwl/ContextNest), published as `@promptowl/contextnest-engine`). This repo consumes the engine as a dependency.

In this community repo, only build community-edition concerns on top of the engine: routes, governance, MCP wiring, UI, telemetry. If a task requires new or changed base engine logic, implement it upstream in the engine package and consume it here — do not fork engine behavior into this repo.

## Engine & CLI Sync Discipline

The `Engine Logic Boundary` above says *where* engine logic lives. This section is the standing rule for *staying in sync* with it. The API convergence effort ([docs/prds/api-convergence.md](docs/prds/api-convergence.md)) is moving the CLI, MCP, and REST surfaces onto one canonical operation catalog sourced from the engine — follow these rules so this repo never drifts from that contract:

1. **ALWAYS check upstream first.** Before starting *any* engine-adjacent work — MCP tool definitions or schemas, CLI-facing operations, versioning/hashing/prompt-compilation, governance vocabulary, selector grammar, or wire shapes — check the upstream repo [PromptOwl/ContextNest](https://github.com/PromptOwl/ContextNest) for the latest `@promptowl/contextnest-engine` and `ctx` CLI (`@promptowl/contextnest-cli`) setup, and confirm this repo consumes the latest published engine (`npm view @promptowl/contextnest-engine version`).
2. **Track latest.** Keep the engine pin in `package.json` within one release of the latest engine. Bump promptly when a new engine ships (the community lockfile should track latest within one release).
3. **Push divergence upstream — never fork.** If a change here would risk diverging from the engine/CLI contract (tool names, JSON schemas, governance vocabulary, selector grammar, wire shapes), do NOT implement it in this repo. Implement and **commit it back upstream** in `PromptOwl/ContextNest`, then consume it here as a dependency. Open a PR against the engine repo for that work.
4. **Canonical vocabulary.** MCP naming is `context_*`. Governance is `context_submit_review` / `context_approve` / `context_reject` (drift suggestions are a `drift` origin of the same ops, not a separate vocabulary). Do not introduce parallel names.
5. **No new inline schemas.** MCP tool schemas will import from `@promptowl/contextnest-engine/api` once that module ships. Do not add new inline `inputSchema` object literals in `src/mcp/` — this is enforced by `npm run lint:mcp-schemas` (see the divergence guard in `scripts/check-mcp-schemas.mjs`).

## Key Patterns

### Testing

Tests use isolated data directories with mocked licenses:

```typescript
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed } from './helpers';

beforeEach(() => setupTestEnv());

const app = await createTestApp('key');
const user = await registerUser(app, 'user@example.com');
const { status, data } = await jsonRequest(app, 'POST', '/nests', { name: 'Test' }, user.apiKey);
```

### App pages

One folder per page under `ui/src/pages/app/<slug>/`: `meta.ts` (path, label, icon, order, optional badge) + `page.tsx` (default-export component, reads navigation via `useAppNav()`). `ui/src/lib/pages.ts` builds the registry from the folders — App, sidebar and URL sync derive from it, so nothing else needs editing. `pages.test.ts` guards the invariants. Nest views (Board, Graph, Definitions, Workflows) follow the same pattern under `ui/src/pages/nest/<slug>/` with `ui/src/lib/nest-pages.ts` (`meta.viewPage` names the App view; `meta.visible` is the gate; URL is `/nest/<id>/<meta.path>`). The former user-menu pages (Teammates, Server settings, Activity trace, API keys, Teams, How it works, Account) are app pages: `meta.group` (`work` / `workspace` / `admin` / `help`, from `PAGE_GROUPS`) places the row in a collapsible rail group, `meta.visible` gates it (admin pages), `meta.hidden` keeps it out of the rail (Account, opened from the user menu). `appRail(caps)` is what the sidebar draws. A page sets its part of the header breadcrumb with `useBreadcrumb()` (`ui/src/lib/breadcrumb.tsx`); App adds Home and the nest in front.

### Auth Modes

- **KEY mode** (default): Requires `Authorization: Bearer cnst_<token>` or session cookie
- **OPEN mode**: No auth, anonymous admin user (local/LAN only)

### Stewardship Roles

- **Viewer**: read-only
- **Editor**: read/write, no approval
- **Reviewer**: full approval rights

Scope resolution: document → tag → nest → owner

## Pull requests

Every PR — human- or AI-authored — must have both of these, or the Claude review marks it 🔴 blocking (full rules in `REVIEW.md`):

1. **Ticket** referenced. The standard is a `Task: <Engineering Ops nest URL>` first line in the body, one per ticket. ClickUp references (`CU-<id>`, `[CU-<id>]`, `#<id>`, or an `app.clickup.com/t/<id>` link) are still accepted during the transition. If you don't know the ticket, ask — don't open the PR without it.
2. **Steps to test** section in the body: numbered steps a tester can follow from the user's perspective — where to go or what to run, what to do, what they should see. "Unit tests pass" is not test steps. Use `N/A — no user-facing change` plus a reason only for docs/CI/chore PRs.

## Configuration

See `CONFIGURATION.md` for the full environment variable reference (PORT, DATA_ROOT, AUTH_MODE, PROMPTOWL_KEY, …).

## Documentation

- `README.md` - Quick start, features
- `CONFIGURATION.md` - Full env var reference
- `API.md` - Complete endpoint reference
- `STEWARDSHIP.md` - Governance model
- `LICENSING.md` - Plans, seats, model credits, license checks
- `CHANGELOG.md` - Release history
- `docs/prds/api-convergence.md` - PRD: one CLI / one MCP across OSS and Community (drives the Engine & CLI Sync Discipline)
