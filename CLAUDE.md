# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ContextNest Community Edition is a self-hosted context governance server for AI workflows, part of the ContextNest ecosystem in the PromptOwl GitHub organization. It enables organizations to deploy their own context governance infrastructure with full stewardship workflows already configured.

This monorepo combines a Node.js backend (Hono framework) with a React frontend, providing markdown-based context documents ("nests") with stewardship workflows, version control, and MCP (Model Context Protocol) integration.

## Engine Logic Boundary

**Base/core engine logic must NOT be added to this repo.** Anything fundamental to the engine — core versioning, hashing, prompt compilation — belongs in the upstream ContextNest engine package ([PromptOwl/ContextNest](https://github.com/PromptOwl/ContextNest), published as `@promptowl/contextnest-engine`). This repo consumes the engine as a dependency.

In this community repo, only build community-edition concerns on top of the engine: routes, governance, MCP wiring, UI, telemetry. If a task requires new or changed base engine logic, implement it upstream in the engine package and consume it here — do not fork engine behavior into this repo.

## Commands

```bash
# Development
npm run dev              # Run server + UI concurrently (tsx watch + vite watch)
npm run dev:server       # Backend only
npm run dev:ui           # Frontend only

# Build
npm run build            # Full build (server + UI)
npm run build:server     # Backend only (tsup)
npm run build:ui         # Frontend only (vite)

# Testing
npm run test             # Run tests once (vitest run)
npm run test:watch       # Watch mode
npm run test -- <file>   # Run specific test file

# Type checking
npm run typecheck        # tsc --noEmit

# Production
npm start                # node dist/index.js
```

## Architecture

### Backend (`/src` - 48 files)

```
src/
├── index.ts              # CLI entrypoint, server startup
├── app.ts                # Hono app factory, route registration
├── config.ts             # Environment config loader
├── auth/                 # Authentication, licensing, API keys, sessions
├── nests/                # Vault CRUD, sharing, collaborators
├── nodes/                # Document CRUD, versioning, prompt compilation
├── governance/           # Stewardship workflows, access control, approvals
├── mcp/                  # Model Context Protocol endpoints + tools
├── db/                   # SQLite client, migrations, backfill
├── shared/               # Types, errors, rate limiting
├── fs/                   # Vault import utilities
└── telemetry/            # Usage tracking
```

### Frontend (`/ui/src` - 78 files)

React 18 + TipTap editor + Radix UI components. Key files:
- `App.tsx` - Main shell with routing
- `components/DocumentEditor.tsx` - TipTap rich editor with wiki links
- `components/DocumentViewer.tsx` - React Markdown reader
- `components/NestList.tsx` - Dashboard, import folder modal
- `lib/api.ts` - Fetch helpers with auth

### Database (SQLite)

Tables: `users`, `sessions`, `api_keys`, `nests`, `nest_collaborators`, `nodes`, `node_versions`, `stewards`, `schema_migrations`

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

### Auth Modes

- **KEY mode** (default): Requires `Authorization: Bearer cnst_<token>` or session cookie
- **OPEN mode**: No auth, anonymous admin user (local/LAN only)

### Stewardship Roles

- **Viewer**: read-only
- **Editor**: read/write, no approval
- **Reviewer**: full approval rights

Scope resolution: document → tag → nest → owner

### Request Flow

1. Auth middleware (cookie/Bearer parsing)
2. Route handler
3. Access guard filters by stewardship permission
4. DB/engine operations
5. Response serialization

## Configuration

Key environment variables (see `CONFIGURATION.md` for full reference):

| Variable | Default | Purpose |
|----------|---------|---------|
| PORT | 3838 | HTTP listen port |
| DATA_ROOT | ./data | SQLite + nest storage |
| AUTH_MODE | key | `key` or `open` |
| PROMPTOWL_KEY | - | License key (pk_...) |

## Adding Features

**New API Endpoint:**
1. Add handler in `src/<domain>/routes.ts`
2. Register route in `app.ts` with auth guards
3. Add test in `/test/*.test.ts`
4. Update `API.md`

**New UI Component:**
1. Create in `ui/src/components/`
2. Integrate into `App.tsx` or parent component
3. Use existing Radix primitives from `ui/src/components/ui/`

## Key Dependencies

- **hono** - HTTP framework
- **better-sqlite3** - SQLite bindings
- **@promptowl/contextnest-engine** - Core versioning/hashing
- **zod** - Schema validation
- **@tiptap/react** - Rich text editor
- **react-markdown** - Markdown rendering
- **vite** - Frontend bundler
- **tsup** - Backend bundler
- **vitest** - Test framework

## Documentation

- `README.md` - Quick start, features
- `CONFIGURATION.md` - Full env var reference
- `API.md` - Complete endpoint reference
- `STEWARDSHIP.md` - Governance model
- `CHANGELOG.md` - Release history
