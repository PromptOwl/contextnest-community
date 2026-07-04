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
   discovery calls needed.
2. **Walk** — start at the agent node. For each outgoing flow edge, evaluate
   its condition per mode: `structured` deterministically; `nl`/`open` by
   judgment (record the rationale). Follow edges whose conditions hold.
3. **Read deterministically** — use `POST /nests/{nest}/context` with explicit
   `selector` + `hops` and record both in the step detail. Deterministic
   retrieval is what makes a run replayable: re-issuing the recorded reads
   reproduces the identical read-set.
4. **Step** — `POST /runs/{run_id}/steps` after every action:
   `{seq?, action: read|write|branch|notify|external, node_id?, edge_id?, detail?}`.
   For `branch` steps include the evaluated condition, the result, and (NL
   mode) the rationale.
5. **Close** — `PATCH /runs/{run_id}` with
   `{status: succeeded|failed|cancelled, trace?: {…totals}}`. Terminal is
   final: further steps or PATCHes 409.

Run history: `GET /nests/{nest}/runs?agent=&status=` · full trace:
`GET /runs/{run_id}` (step `detail` is redacted below write tier).

## Guardrails

- Sub-Turing by design: flow graphs are DAGs; there are no unbounded loops to
  audit. Schedules (agent `schedule` field) provide iteration; the graph
  provides branching; the nest provides memory.
- Everything is governed: edge types, edges, and the agent nodes themselves
  are versioned and steward-reviewable; runs record who triggered what and
  every branch decision.

*The full design (contracts, condition semantics, prototypes) lives in the
Governed Workflow Plane PRD. `/llms.txt` integration and MCP run tools follow
once the agent-entrypoint PR lands.*
