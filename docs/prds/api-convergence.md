# PRD: API Convergence — One CLI, One MCP Across ContextNest OSS and Community

**Status:** Proposed · **Date:** 2026-07-12 · **Owner:** Qaish **Governing rules:** Plumbing-Down-Policy-Stays · The AGPL↔Commercial Line · Engine Versioning Discipline

## 1. Problem

The agent/developer-facing API has forked into three vocabularies for the same operations:

| Surface | Where | Tools/ops | Naming |
|---|---|---|---|
| OSS MCP server | `PromptOwl/ContextNest` `packages/mcp-server` | 19 tools | `read_document`, `resolve`, `search`, `stage_drift_suggestion`… |
| Community MCP | this repo `src/mcp/tools.ts` + `workflow-tools.ts` | 22 `context_*` + 11 `workflow_*` | `context_get`, `context_query`, `context_approve`… |
| OSS CLI | `packages/cli` (`ctx`) | ~25 commands | `ctx query`, `ctx add`, `ctx publish`… |

Plus a fourth: the Community REST API (`API.md`).

Specific damage:

- **Zero shared schema source.** Both `tools.ts` files hand-write inline JSON schemas (~1,100 lines here). Any change diverges silently.
- **Two governance vocabularies.** OSS grew `stage_drift_suggestion` / `approve_suggestion` / `reject_suggestion` in parallel with Community's `context_submit_review` / `context_approve` / `context_reject`. Same concept, disjoint APIs — agents learn two mental models of "propose → approve."
- **Engine pinned at 1.0.0** (lockfile) while latest is 1.2.1, violating the tracking discipline; the 1.0.0→1.2.1 bump was audited test-clean but never landed.
- Semantic overlap is near-total on core ops: `context_get`↔`read_document`, `context_query`↔`resolve`, `context_list`↔`list_documents`, `context_create/update`↔`create_document/update_document`, `context_search`↔`search`.

## 2. Goals / Non-Goals

**Goals**

1. One canonical operation catalog; MCP tools, `ctx` commands, and REST routes are three *bindings* of it.
2. One CLI (`ctx`, AGPL) usable against both a local vault and a Community/TheOwl server.
3. One MCP tool vocabulary everywhere; servers differ only in which capability namespaces they expose.
4. Structural enforcement (CI) so divergence fails builds instead of accumulating.

**Non-Goals**

- Moving governance *enforcement* (eligibility gate, scope resolution, approvals) out of Community. Signatures are spec-public; enforcement stays commercial (Plumbing-Down-Policy-Stays).
- Merging repos or changing the license map.
- Putting Hootie's `POST /nests/:id/chat` in the catalog. It is the UI's assistant — retrieval-as-caller plus a model call — not an operation an agent needs: an MCP client or `ctx` user *is* the assistant and already has `context_*` / `ctx query`. Deliberately REST/UI-only.

## 3. Target Architecture

**The engine is the canonical schema source** (decided 2026-07-12). The engine already canonically defines the domain layer (`frontmatterSchema`, `ContextNode`, selector grammar, `parseConfig`); the missing piece is the wire contract. Add it as a new engine module exported at a subpath:

**`@promptowl/contextnest-engine/api` — AGPL-3.0 (part of the engine).**

- Zod schemas + JSON Schema output for every operation: name, input, output, error model. Transport-agnostic.
- Capability namespaces: `core`, `governance`, `workflow`, `sync`.
- Generated docs (tool tables for READMEs / API.md sections).
- Composes the engine's existing domain schemas rather than duplicating them — one source for both format and wire shapes.
- Community imports it under PromptOwl's self-license (copyright holder is not bound by AGPL).

**Accepted trade-offs and mitigations:**

1. *Third-party embeddability:* importing tool schemas from the AGPL engine carries copyleft obligations. Mitigation: the canonical *operation catalog document* (names + JSON Schemas, generated from the engine module) is published into the Apache-2.0 spec (`CONTEXT_NEST_SPEC.md` companion), so third parties can implement the surface from the spec without importing AGPL code. Import = copyleft; re-implement from spec = free. This preserves the funnel at the spec level.
2. *Self-licensing risk:* one external PR touching engine code breaks PromptOwl's ability to self-license it into Community. Mitigation: **a CLA on the OSS repo becomes mandatory, not optional** — promoted to a hard Phase 0 gate.
3. *Cadence coupling:* API-only changes force engine version bumps. Accepted; mitigated by the Renovate auto-bump discipline (Phase 3) keeping Community on latest anyway.

**Canonical naming: `context_*`** (Community's set — richer, self-namespacing for agents). OSS mcp-server adopts these names; old names ship as deprecated aliases for 2 minor releases, then removed.

**Governance vocabulary: Community's.** OSS drift-suggestion tools are re-expressed as the ungated subset of `governance` namespace ops (`context_submit_review` / `context_approve` / `context_reject` with a `drift` origin field). One mental model.

**Capability discovery:** the MCP `initialize` result (and REST manifest endpoint) advertises implemented namespaces, per the Nest Discovery / Manifest API pattern. OSS local server: `core` (+ ungated `governance` subset). Community: `core + governance + workflow + sync`.

**One CLI:** `ctx` gains a backend abstraction — `local` (engine over filesystem; today's behavior) and `remote` (HTTP client for the Community REST API, auth via existing `cnst_` bearer keys). The vault registry extends to remote aliases: `ctx vault add work https://nest.acme.com --key cnst_…`. Governance commands activate only when the backend advertises `governance`; against a local vault they explain the requirement (organic upsell path). Community never ships a CLI.

## 4. Phases

### Phase 0 — Unblock (prerequisite, ~days)
- [ ] Land engine bump 1.0.0 → latest (1.2.x) in Community. Already audited test-clean.
- [ ] Land the two seam-list engine PRs (stewards serializer, wiki plumbing) + `serializeDocument` frontmatter bugfix.
- [ ] **HARD GATE: CLA on the OSS repo** before any external contribution lands — with schemas living in the AGPL engine, the self-license into Community depends on retaining full copyright.

### Phase 1 — Extract the contract (~1 wk)
- [ ] Create the `api` module in the engine (`packages/engine/src/api/`, exported as `@promptowl/contextnest-engine/api`).
- [ ] Extract schemas *from* Community's `tools.ts` / `workflow-tools.ts` (the richer set) as canonical; reconcile with OSS tool shapes; compose existing engine domain schemas; write the op catalog for `core` first, `governance`/`workflow`/`sync` after.
- [ ] Generate the operation catalog doc and publish it under the Apache-2.0 spec so third parties can implement without importing AGPL code.
- [ ] Deliverable: engine minor release with the `api` subpath + generated catalog doc.

### Phase 2 — Adopt + converge names (~1–2 wks)
- [ ] Community `src/mcp/`: import all tool defs from `contextnest-engine/api`; delete inline schemas; handlers unchanged.
- [ ] OSS mcp-server: same import; adopt `context_*` names; keep old names as aliases logging deprecation warnings.
- [ ] Fold OSS drift tools into governance vocabulary.
- [ ] Regenerate README/API.md tool tables from the spec package.

### Phase 3 — Enforce (~1 wk, parallel with Phase 2)
- [ ] Conformance suite (in the OSS repo; fixtures published with the Apache spec): golden request/response fixtures runnable against any endpoint (stdio or HTTP).
- [ ] Both CIs run it; divergence fails the build.
- [ ] Lint rule in both repos: no inline `inputSchema` object literals in MCP/CLI code — schemas must import from `contextnest-engine/api`.
- [ ] CODEOWNERS on `packages/engine/src/api/`; spec-first process: new op = spec PR (mini-RFC) before implementation PRs.
- [ ] Automated dependency-bump PRs (Renovate) so both repos track the latest engine — extends Engine Versioning Discipline.

### Phase 4 — One CLI (~2 wks, can trail)
- [ ] Backend interface in `packages/cli`; `remote` backend speaking the Community REST API.
- [ ] Vault registry: remote aliases + key storage.
- [ ] Governance/workflow commands gated on advertised capabilities.
- [ ] Community docs point at `ctx` for all CLI use.

## 5. Risks

- **Breaking existing agent configs** on OSS tool renames → mitigated by 2-release alias window + deprecation warnings.
- **Schema module becomes a bottleneck** → keep it schemas-only, no logic; CODEOWNERS review is a contract review, not a code review.
- **Apache patent grant concern** → grant scopes to the schema code itself, not the governed-retrieval method claims; spec doc is already Apache. Confirm with IP counsel alongside the patent filing.
- **REST API drift** (third vocabulary) → Phase 2+ treats REST routes as a binding of the same catalog; generate `API.md` request/response shapes from `contextnest-engine/api` where they overlap.

## 6. Success Criteria

1. `grep -r "inputSchema" src/mcp/` in both repos returns only imports from `contextnest-engine/api`.
2. Conformance suite green in both CIs; a deliberately-diverged fixture fails both.
3. An agent config written for the OSS server works unchanged against a Community server (with more tools visible, never different ones).
4. `ctx query "#tag" --vault work` returns governed results from a remote Community server.
5. Community lockfile tracks the latest engine within one release.
