---
"@promptowl/contextnest-community": minor
---

Push Confirmation Gate — hold agent writes for review on a gated nest.

A superadmin can require confirmation for agent writes to a nest
(`require_push_confirmation`, superadmin-only to set via
`PATCH /nests/:id/settings` — a per-field `403` for anyone else). On a gated
nest, a document created by an agent or script is **held** as a pending record
(`202 pending_confirmation` with a `poll_url`/`confirm_url`) instead of
applying; it lands only after a reviewer confirms it in the web UI, through the
exact same apply path an immediate write uses — same engine create, same version
rows, same skip-don't-overwrite semantics, attributed to the submitter. With the
gate off, behaviour is unchanged.

The gate covers the three ways an agent CREATES a document: the MCP
`context_create` tool (always, whatever credential it arrived on — it answers a
`PENDING_CONFIRMATION` tool error, since nothing was created), `POST
/nests/:id/nodes` on an API key, and the bulk `POST /nests/:id/publish`. A
person working in the web UI (session cookie) is never held, and edits to
existing documents keep going through stewardship review, which is built for
them.

- New `pending_pushes` table (carries the full staged payload so a confirm
  applies it byte-for-byte) and a **per-API-key** `push_allowlist`
  (`key_id` `''`/null = all of that user's keys; never keyed on nest alone).
  Idempotent SQLite + Postgres migrations (`040_push_confirmation`).
- New endpoints under `/nests/:id`: `GET pending-pushes`,
  `GET pending-pushes/:pid` (readable by the **submitter or a reviewer** — the
  CLI polls with the pushing key), `POST …/:pid/confirm { always_allow? }`,
  `POST …/:pid/reject`, `GET/DELETE push-allowlist`. **Confirming is
  reviewer/owner/admin only — never the submitter**, or the gate would be one
  extra call away from being cleared by the key it is holding; a submitter may
  reject (withdraw) its own write. Confirm/reject on a no-longer-pending record
  → `409`, and a confirm whose apply throws returns the record to `pending`
  instead of stranding it as applied-with-nothing-written. Doc/folder grantees
  are denied `/publish`.
- The allowlist is governance-licensed (`503` without a license); the
  `/pending-pushes` routes deliberately are **not** — the write endpoints are
  unlicensed, so licensing the release path would let a lapsed license hold
  every write with nothing able to confirm it, and the nest would stop
  accepting writes with no in-product way back.
- Held payloads are bounded by `MAX_PENDING_PUSH_BYTES` (default 5 MB) and
  expire after `PENDING_PUSH_TTL_MS` (default 7 days), reported lazily as
  `expired`.
- Web UI: a loud confirm modal (which nest — name + id verbatim, how many
  documents + a title·type·tags manifest with new-vs-update badges, who wrote
  them, and an "Always allow automated writes" checkbox that whitelists that
  exact key), a held-write banner + count badge in the nest view, and — in nest
  settings — the superadmin-gated `require_push_confirmation` switch plus the
  list of whitelisted keys with a Revoke action, so "Always allow" is not a
  one-way door. Reviewers are notified when a write is held.
- The nest feed API also emits a `pending_push` item carrying the manifest and
  a per-caller `canConfirm`, for clients that want held writes inline with the
  rest of the activity. The nest view surfaces them through the banner instead,
  so nothing renders that item yet.
- A held write's manifest entry carries the id the title will publish to, or
  `null` when the title has no ASCII slug and the id can only be generated at
  apply time. It is a preview for the new-vs-update badge, not a promise: an id
  that is occupied by the time a reviewer confirms is skipped, never
  overwritten.

Shares one wire contract with the paired `ctx push` change in
`PromptOwl/ContextNest` (the CLI polls the gate and prints the confirm URL) —
the CLI pushes through `POST /nests/:id/publish`, one of the gated surfaces.
