---
"@promptowl/contextnest-community": minor
---

Push Confirmation Gate — hold `ctx push` for review on a gated nest.

A superadmin can require confirmation for pushes to a nest
(`require_push_confirmation`, superadmin-only to set via
`PATCH /nests/:id/settings` — a per-field `403` for anyone else). On a gated
nest, `POST /nests/:id/publish` from a non-whitelisted API key is **held** as a
pending record (`202 pending_confirmation` with a `poll_url`/`confirm_url`)
instead of applying; it applies only after a reviewer confirms it in the web UI,
through the exact same apply path an immediate push uses.

- New `pending_pushes` table (carries the full staged payload so a confirm
  applies it byte-for-byte) and a **per-API-key** `push_allowlist`
  (`key_id` `''`/null = all of that user's keys; never keyed on nest alone).
  Idempotent SQLite + Postgres migrations (`037_push_confirmation`).
- New endpoints under `/nests/:id`: `GET pending-pushes`,
  `GET pending-pushes/:pid` (readable by the **submitter or a reviewer** — the
  CLI polls with the pushing key), `POST …/:pid/confirm { always_allow? }`,
  `POST …/:pid/reject`, `GET/DELETE push-allowlist`. Confirm rights = submitter
  OR reviewer/owner/admin. Confirm/reject on a no-longer-pending push → `409`.
  Governance-licensed (`503` without a license); doc/folder grantees are denied
  `/publish`.
- Held payloads are bounded by `MAX_PENDING_PUSH_BYTES` (default 5 MB) and
  expire after `PENDING_PUSH_TTL_MS` (default 7 days), reported lazily as
  `expired`.
- Web UI: a loud `PushConfirmationModal` (which nest — name + id verbatim, how
  many docs + a title·type·tags manifest with new-vs-update badges, who pushed,
  and an "Always allow automated pushes" checkbox that whitelists the key), a
  held-push banner + count badge in the nest view, an activity-feed
  `pending_push` item with `canConfirm`, and a superadmin-gated
  `require_push_confirmation` switch in nest settings. Reviewers are notified
  when a push is held.

Shares one wire contract with the paired `ctx push` change in
`PromptOwl/ContextNest` (the CLI polls the gate and prints the confirm URL).
