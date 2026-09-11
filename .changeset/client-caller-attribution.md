---
"@promptowl/contextnest-community": minor
---

`client` — caller attribution on every read and write.

Every node write (`POST /nests/:id/nodes`, `PATCH /nests/:id/nodes/:nodeId`,
`POST .../approve`) and every MCP tool call now accepts an optional `client`
object naming the calling agent and its session, plus any custom scalar keys:

```jsonc
{ "title": "API Design", "content": "…",
  "client": { "agent": "claude-code", "session_id": "s-9f2" } }
```

A write that seals a version records it on that version, so version history —
the REST list, `context_versions`, and the history panel in the UI — answers
"which agent wrote v7, in which session". Every MCP tool call and every traced
REST request records it on the activity trace, which is where a READ is
attributed: a read seals no version to carry it. `editedBy` is untouched and
remains the authoritative authoring record.

Everything about it is optional — the object and each field within it. No
endpoint requires it, an unattributed call is a valid call, and a call carrying
none stores nothing rather than an empty `{}`: "not attributed" and "attributed
to nobody" are different claims.

The server fills what the transport already knows under anything the caller
sent, merged per key, so a caller that names its agent but no session keeps its
agent and still gains a session id: `agent` from the API key's label,
`session_id` from an `Mcp-Session-Id` header. `CONTEXTNEST_AGENT` /
`CONTEXTNEST_SESSION_ID` override those; `CONTEXTNEST_NO_ATTRIBUTION=1` derives
nothing, which matters because what is derived lands in an append-only history —
consent has to be available before the first write, not after. Nothing is
synthesized where the transport knows nothing: a placeholder session id would be
indistinguishable from a real one.

`client` is a label, not an identity claim: never authenticated, never used to
authorize, and deliberately not an input to any hash chain, so histories
recorded before the field existed keep verifying byte for byte. It is bounded
(scalar values ≤512 chars, ≤16 custom keys) because an untrusted caller writes
it into an append-only audit trail, and a near-miss on a reserved key
(`sessionId`, `Agent`) is rejected rather than filed as a custom key — which
would leave the write looking attributed while the slot readers check stays
empty. It is distinct from `metadata`, which is frontmatter and describes the
document rather than the call.

Specified in `CONTEXT_NEST_SPEC.md` §9.4 upstream (PromptOwl/ContextNest#107);
this is the Community Edition binding of it, over this server's own version
rows and activity trace.
