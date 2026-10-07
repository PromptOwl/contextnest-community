# The Workflow Plane ("turing" track)

Typed edges, an edge-type registry, and governed runs. **Optional — off by
default.** Enable with `FEATURE_WORKFLOW_PLANE=true` (or Settings → Workflow
plane); every plane route 404s until then.

## Concepts

- **Edge types** (`/nests/:id/edge-types`) — the steward-articulated vocabulary
  of relations (`next`, `on-failure`, `escalates-when`, `derives-from`,
  `owned-by`…). Types with `is_flow` participate in workflow control flow and
  are DAG-validated. A type may carry a `condition_schema` template
  (`{params, mode_default}`).
- **Edges** (`/nests/:id/edges`) — typed links between documents. Optional
  condition, in one of three modes: `structured` (JSON predicate; a `term`
  resolves against the definitions glossary), `nl` (judged by an LLM runner at
  execution time, rationale logged), `open` (freeform). Flow edges must form
  a DAG — cycles are rejected with a 409 naming the path.
- **Runs** (`/nests/:id/run/<agent>`, `/runs/:id`) — the operational trace.
  The server never executes anything; external runners do.

## Runner contract

An external runner (Hootie, Claude, a Temporal worker, cron + curl) executes a
workflow like this:

1. **Trigger** — `POST /nests/{nest}/run/{agent-node}` (write-tier key). The
   response is the complete executable bundle: the agent/skill node's
   instructions, the flow-edge subgraph reachable from it (with conditions and
   referenced glossary definitions), and a `run_id`. One round-trip; no
   discovery calls needed. Optional body: `inputs` (recorded on the run) and
   `parent_run_id` — set the latter to spawn this as a **sub-agent run** nested
   under a still-running parent (requires `FEATURE_SUBAGENT_RUNS`; the response
   carries `parent_run_id` and `depth`). See Guardrails for the recursion caps.
2. **Walk** — start at the agent node. For each outgoing flow edge, evaluate
   its condition per mode: `structured` deterministically; `nl`/`open` by
   judgment (record the rationale). Follow edges whose conditions hold.
3. **Read deterministically** — use `POST /nests/{nest}/context` with explicit
   `selector` + `hops` and record both in the step detail. Deterministic
   retrieval is what makes a run replayable: re-issuing the recorded reads
   reproduces the identical read-set.
4. **Step** — `POST /runs/{run_id}/steps` after every action:
   `{action: read|write|branch|notify|external, node_id?, edge_id?, detail?}`.
   `seq` is assigned server-side (monotonic per run) and returned in the
   response — any client-supplied `seq` is ignored. For `branch` steps include
   the evaluated condition, the result, and (NL mode) the rationale.
5. **Close** — `PATCH /runs/{run_id}` with
   `{status: succeeded|failed|cancelled, trace?: {…totals}}`. Terminal is
   final: further steps or PATCHes 409.

Run history: `GET /nests/{nest}/runs?agent=&status=` · full trace:
`GET /runs/{run_id}`. Below write tier the freeform payloads — run `inputs`,
run `trace`, and each step's `detail` — are redacted to `null`; a read-tier
caller still sees the run's existence, agent, status, timing and step order.

## MCP tools

The same build-and-execute surface is available to MCP agents on any nest's
`/mcp` endpoint (advertised only when the flag is on). Each tool calls the same
service/validator code as its REST route, so behaviour can't drift.

- **Build** — `workflow_edge_types_list` · `workflow_edge_type_upsert` ·
  `workflow_edge_type_delete` · `workflow_edges_list` · `workflow_edge_create`
  (DAG cycle guard + condition validation) · `workflow_edge_delete`.
- **Execute** (the agent is the runner) — `workflow_run` (→ bundle + run_id) ·
  `workflow_run_step` · `workflow_run_close` · `workflow_run_get` ·
  `workflow_runs_list`.

Write tools need write tier; run-detail tools scope the `run_id` to the caller's
nest. Redaction matches the REST read tier.

## UI

A read-only **Runs** tab (nest header, shown when the flag is on) lists a nest's
runs with status/agent filters and opens a trace viewer — steps in order, branch
decisions, and inputs/trace/detail shown when the viewer has write access
(redacted otherwise). The server still never executes; the UI observes runs that
external runners produced.

## The one exception: metacognition agents

With `FEATURE_METACOGNITION=true`, an owner or admin can make an agent
document a **metacognition agent** (`PUT /nests/:id/metacognition/:node`).
Those the server runs itself — everything else here is still executed by
external runners. The boundary moves only as far as it has to:

- **Claimed at creation.** A metacognition run is inserted with
  `claimed_by = "server:metacognition"`, whichever way it starts (manual
  trigger, `POST /run/:agent`, a schedule, an inbound hook), so a poll-mode
  runner never sees it, and `/runnables` leaves these agents out. Only the
  server appends its steps; a person can still cancel it.
- **Proposals only.** The loop's tools read (within the configured folders and
  the configuring owner's access, approved text only) and propose: an edit or
  a new document lands as a draft submitted for review, authored by the
  agent's persona (a service identity), never published. Comments are
  comments. Nothing approves, publishes, deletes or changes permissions.
- **Untrusted inputs fenced.** Feeds (configured list only), MCP results
  (configured servers, allow-listed tools only), trigger inputs and even the
  nest's own document text reach the model fenced as data. Outbound requests
  check the resolved address at connect time (no private addresses, no DNS
  rebinding), follow no redirects, and cap response size.
- **Bounded.** Caps on turns, tokens, wall-clock seconds and proposals per
  run, one run per agent at a time, the plane's per-nest concurrency cap.
- **Observable.** Every reasoning step and tool call is a run step; the run's
  trace carries the persona, model, token usage, a cost estimate and who pays
  (`promptowl_credits` or `own_key`), and the closing summary.
- **Reflective.** Each run is shown the agent's recent runs and the verdicts
  on its proposals (rejection notes included), and withdraws its own rejected
  drafts so the working copy is the approved text again.

MCP servers are reached over Streamable HTTP through the same guarded fetch:
each response is capped (2 MB) and an idle socket closes after 30 s, so a
server that holds one long-lived SSE stream open will see it cut and
reconnected. Request/response MCP servers are unaffected.

A run that cannot start — no model key, instructions not yet approved, the
configuring owner lost write access — is closed `cancelled` with
`trace.skipped` saying why.

## Guardrails

- Sub-Turing by design: within a run, flow graphs are DAGs; there are no
  unbounded loops to audit. Schedules (agent `schedule` field) provide
  iteration; the graph provides branching; the nest provides memory.
- Bounded recursion (`FEATURE_SUBAGENT_RUNS`, off by default, gated separately
  from the plane): a run may spawn nested sub-agent runs via `parent_run_id`,
  but the call tree stays finite and haltable. The trigger validates the parent
  chain and rejects anything that would break that bound —
  - **depth** capped at `SUBAGENT_MAX_DEPTH` (tree height) → 403;
  - **fan-out** capped at `SUBAGENT_MAX_CHILDREN` per run (tree width),
    enforced atomically with the child insert so concurrent spawns can't
    overrun it → 403;
  - **re-entrancy** rejected — an agent already anywhere in the ancestor chain
    can't reappear (the per-run DAG guard can't see across run boundaries) →
    409;
  - a closed or cross-nest/unknown parent is refused (409 / 404).
  Per-run step logs are independently capped at `RUN_MAX_STEPS`. Until the flag
  is on, any `parent_run_id` is rejected (400) and none of this surface is live.
- Everything is governed: edge types, edges, and the agent nodes themselves
  are versioned and steward-reviewable; runs record who triggered what and
  every branch decision.

*The full design (contracts, condition semantics, prototypes) lives in the
Governed Workflow Plane PRD. `/llms.txt` advertisement of these tools follows
once the agent-entrypoint PR lands.*
