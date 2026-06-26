# Stewardship — Quick Guide

A short, practical guide to the governance model the community server implements. The deep strategy lives in `docs/contextnest-whitepaper.md`; this is the "how does this actually work in the product" version.

## The two modes

Every nest is either **ungoverned** or **governed**, controlled by the `stewardship_enabled` flag on the nest.

| | Ungoverned (default) | Governed |
|---|---|---|
| New documents | Auto-approved, immediately available to AI | Start as **drafts**; need steward approval |
| Draft / pending / rejected lifecycle | Not shown | Shown, filterable |
| Review queue | Hidden | Visible, orderable |
| Stewards | Not shown | Assignable by scope |
| Reads gated by permission | No | Yes (in key mode) |

Flip the flag any time via **Settings → Stewardship**. Existing approved docs stay approved; existing drafts remain drafts.

## What a steward is

A **steward** is a person (identified by email) who governs a subset of the nest. Stewards have one of three roles:

| Role | Can read | Can edit | Can approve / reject |
|---|---|---|---|
| **Viewer** | yes | no | no |
| **Editor** | yes | yes | no |
| **Reviewer** | yes | yes | **yes** |

> **Authors can't approve their own work.** Even a reviewer-level steward can't approve a version they themselves authored. Separation of duties, enforced server-side.

## Scope — who governs what

Stewards are assigned at one of three scopes. When a document needs a steward (to approve, or to check access), the server resolves them in this order — **first match wins**:

| Priority | Scope | Target | Example |
|---|---|---|---|
| 1 | **Document** | Exact node id | `nodes/pricing-policy` — only this one doc |
| 2 | **Tag** | Tag name (lowercased, no `#`) | `security` — any doc tagged `#security` |
| 3 | **Nest** | (none — applies to the whole nest) | The fallback for anything not covered above |

If nothing matches and no steward resolves, the **nest owner** is the implicit steward (owner fallback). That keeps a freshly-enabled nest workable even with zero stewards configured.

## The approval flow

1. **Author** creates or edits a doc. In governed mode it saves as a **draft**.
2. **Author** clicks **Submit for Review**. The doc becomes **pending** and appears in the review queue for anyone whose scope resolves to that doc.
3. A **Reviewer steward** opens the review queue, reads the doc, clicks **Approve** or **Reject**. Rejecting requires a note.
4. On approve, the doc becomes **approved** and is now AI-readable. The approved version number is pinned (`approvedVersion`), so subsequent drafts don't automatically replace it — AI keeps getting the last blessed version until a new one is approved.

## Who sees what

Governance gates two things: who can **approve**, and who can **read**.

- **Approve gate**: server-side, always on when stewardship is enabled. Non-stewards can't approve.
- **Read gate**: only active in **key mode** (`AUTH_MODE=key`, real user accounts with API keys). In **open mode** — which is the default for a solo/local server — everyone is the same anonymous admin, so read-gating is a no-op.

In key mode, when stewardship is enabled on a nest:
- Node list / single-read / search / query responses are filtered to docs the caller can access
- A non-steward gets an empty list or a 403 on the node they asked for
- The nest **owner** and any resolved **steward (any role)** can read; **super admins** configured in `access.yaml` bypass the check

## Server super-admins

`access.yaml: super_admins` lists emails who administer **every** nest on the server without being added per-nest. A super-admin can:

- Read every document (bypasses the read gate, even with stewardship enabled)
- Change a nest's visibility (public / private)
- Add, remove, and re-role collaborators
- Add, remove, and re-role stewards
- Approve and reject pending versions in any nest's review queue

What a super-admin **cannot** do (owner-only operations):

- Delete a nest
- Transfer ownership

Use this for a small set of platform operators — a CEO, a head of governance, an internal compliance admin — not as a default broad-access mechanism. Day-to-day governance should still flow through per-nest stewards.

## Picking a scope when you assign a steward

Rules of thumb:

- **Nest scope** — use sparingly. "This person reviews everything in this nest."
- **Tag scope** — the most common. "Legal reviews anything with `#legal`. Security reviews `#auth` and `#pii`."
- **Document scope** — override. "This specific doc has a dedicated reviewer regardless of its tags."

You can stack them: a doc tagged `#legal` can have a doc-level steward that overrides the tag steward. Priority order resolves ties.

## `stewards.yaml` (optional)

You can also declare stewards declaratively via a `stewards.yaml` file in the nest's vault directory and run `POST /nests/:id/stewards/sync`. Useful for version-controlled governance. Example:

```yaml
version: 1
nest:
  - email: governance-lead@acme.com
    role: reviewer
tags:
  "#legal":
    - email: legal@acme.com
      role: reviewer
  "#security":
    - email: security-team@acme.com
      role: reviewer
```

Sync replaces all stewards for that nest from the file. Prefer the UI for day-to-day adds; prefer the file for reproducible setups and code review.
