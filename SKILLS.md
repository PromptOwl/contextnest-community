# Skills — Architecture Note

Skills are programs that an external agent runs against a nest. The community server is a **data plane** — it stores, governs, and serves context. It never executes agent code.

## What a skill is

A skill is a regular nest node with `type: "skill"`. Its markdown body contains the instructions an agent follows — inputs, steps, guard rails, output format — the same format Hootie already parses. Example:

```markdown
---
title: Link Fixer
type: skill
tags:
  - "#maintenance"
  - "#auto"
status: approved
---

**Trigger:** on-demand or hourly cron
**Inputs:**
- `nest_url` (string, required) — base URL of the community server
- `api_key` (string, required) — agent key with write access

## Steps

1. Fetch all nodes: `GET /nests/:id/nodes`
2. For each node, extract `[[wiki links]]` from the body.
3. Check each link target exists (title match against the node list).
4. For broken links, propose a fix: closest title match by edit distance.
5. `PATCH /nests/:id/nodes/:nodeId` with the corrected body.
6. If stewardship is enabled, the patch creates a draft; a steward reviews.
```

Because skills are nest nodes, they're governed like everything else: a steward can approve or reject a skill before it's used, version history tracks changes, and the review queue shows agent-proposed edits alongside human edits.

## Who runs it

Not the server. The operator picks their own orchestrator:

| Runner | How |
|---|---|
| **Claude Code** | `claude -p "Read the Link Fixer skill from my nest and execute it"` |
| **Hootie desktop** | Skills page → Run button (sends skill steps to the active LLM) |
| **Cron + curl + any LLM** | Shell script that fetches the skill via API, pipes to an agent CLI |
| **GitHub Actions** | Scheduled workflow that calls the nest API |
| **n8n / Zapier / Temporal** | Workflow node that hits `POST /context` then acts on the result |

The runner authenticates with a `cnst_*` API key (optionally scoped to a single nest). It reads the skill node, follows the steps, and writes back through the existing API — `PATCH /nodes`, `POST /review-requests`, `POST /feedback`.

The server doesn't know a skill is running. It just sees authenticated API calls. No scheduler, no plugin runtime, no process manager, no dependency on any specific LLM.

## What the server provides

The server's job is to make skills effective without embedding a runtime:

| Capability | Endpoint | Exists today |
|---|---|---|
| Read skill instructions | `GET /nests/:id/nodes/:skillId` | Yes |
| Read context for the skill to act on | `POST /nests/:id/context` | Yes |
| List all skills in a nest | `GET /nests/:id/nodes` (filter `type=skill`) | Yes |
| Write back (create/edit nodes) | `POST /nodes`, `PATCH /nodes/:id` | Yes |
| File a review request | `POST /nodes/:id/submit-review` | Yes |
| Approve/reject (human steward) | `POST /nodes/:id/approve` | Yes |
| Report feedback signals | `POST /nests/:id/feedback` | Planned |
| Agent identity in audit trail | `actor_type: "agent"` on users | Planned |

The two planned items are small additions to the existing schema — not new subsystems.

## Built-in skill library (shipped as starter content)

These are markdown skill nodes that ship with the server or are installable from a starter pack. They don't require any special server support — they use the same API surface any external client would.

| Skill | What it does |
|---|---|
| **Link Fixer** | Scans for broken `[[wiki links]]`, proposes corrections via PATCH |
| **Stale Content Flagger** | Nodes not re-approved in N days get a review request filed |
| **Tag Normalizer** | Finds inconsistent tag usage (`#API` vs `#api`), proposes cleanup |
| **Coverage Gap Detector** | Reads the full nest, identifies topics referenced but undocumented |
| **Digest Generator** | Summarizes recently-approved changes into a changelog node |
| **Auto-Improvement Loop** | Reads feedback signals, identifies lowest-rated nodes, proposes rewrites |

## Why no embedded runtime

- **Modularity**: operators use whatever agent framework they already have. The server doesn't pick an LLM for them.
- **Security**: agent code never runs inside the trust boundary of the data store. A buggy skill can't corrupt the DB or bypass governance.
- **Simplicity**: no scheduler state, no job queue, no worker pool, no dependency management. The server stays a fast, stateless API.
- **Composability**: skills can call other services (search the web, query a database, hit another API) without the server needing to know.
- **Upgradability**: swapping the LLM powering a skill is a config change in the runner, not a server deploy.

## The autoresearch parallel

Karpathy's [autoresearch](https://github.com/karpathy/autoresearch) demonstrates this pattern exactly: `program.md` (the skill) is a markdown file that tells the agent what to do. The agent reads it, acts, and writes results back. The human iterates on `program.md` to improve the agent's behavior over time. The agent never modifies `program.md` — that's the governance boundary.

In ContextNest terms:
- `program.md` = a `type: skill` node in a governed nest
- The human iterating on it = a steward approving new versions
- The agent running experiments = an external runner with a `cnst_*` key
- `results.tsv` = feedback signals written back through the API
- The experiment loop = a cron trigger calling the runner

The server is the governed knowledge layer. The agent is the executor. The boundary is the API.
