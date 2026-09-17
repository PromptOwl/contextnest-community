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

### Auto-publish owner & admin edits (`allow_self_approve`)

A per-nest flag (**off** by default; nest Settings → "Auto-publish owner & admin edits"). When it's **on**, a create or edit by the nest **owner** or an **admin** publishes immediately — it skips steps 2–4 entirely instead of landing as a draft. This is a governance *bypass* for the two roles that already hold approval authority, not a separation-of-duties exception. **Editor and reviewer flows are unchanged**: their edits still save as drafts and go through Submit → Review → Approve regardless of the flag. The pending-review edit lock still applies, so an owner/admin can't overwrite a doc a teammate has in review. Turning the flag back off doesn't unpublish anything; it only affects future edits.

## Prime documents

Most content in a nest doesn't need a review gate — call notes, social drafts, scratch research. A small set does: messaging architecture, the sales playbook, pricing policy. **Prime** marks that second set.

A prime document **always** goes through draft → pending → approved, no matter who writes it. It is the one thing `allow_self_approve` does not bypass: an owner editing a prime document still lands a draft.

### How a document becomes prime

Resolution mirrors the steward scope order — **document → tag → nest**, first match wins:

| Priority | Scope | How it's set |
|---|---|---|
| 1 | **Document** | The Prime switch in the document editor (owner/admin only). `true` forces prime; `false` **exempts** this one doc from an otherwise-prime tag. |
| 2 | **Tag** | The doc carries one of the nest's **prime tags** (Settings → Prime tags; `prime-document` out of the box). |
| 3 | **Nest** | Nothing matched → not prime. |

Only the nest owner or an admin can set or clear the document flag — it's a governance decision, not an authoring one. Otherwise any editor could un-flag the playbook and walk their own edit past the gate.

### Reviewing prime documents only (`prime_only_review`)

A per-nest flag (**off** by default; nest Settings → "Review prime documents only"). It changes what a governed nest's *default* is:

| | `prime_only_review` off (default) | on |
|---|---|---|
| Ordinary document, any author | Draft → review → approve (unless the author has a self-approve bypass) | **Publishes immediately** |
| Prime document, any author | Draft → review → approve | Draft → review → approve |

That's the "most content self-publishes, high-stakes content is gated" posture. Leaving it off preserves the original behaviour, so turning stewardship on doesn't silently change meaning for an existing nest.

While `prime_only_review` is on, `allow_self_approve` has no effect at all — non-prime documents already publish for everyone, and prime documents ignore the bypass. Settings disables that switch and says so rather than leaving a live control that changes nothing.

Prime only applies to **governed** nests. With stewardship off there are no stewards to approve anything, so a prime tag is inert until you turn stewardship on.

### At a glance

Prime documents carry a **Prime** badge in the nest's document list, with a tooltip saying whether it came from the document flag or an inherited tag. To see every document a given prime tag covers, filter the list by that tag.

Flipping any of this only affects **future** writes. Marking a published document prime doesn't unpublish it; the next edit is what needs approval.

## Creators review their own documents (`creator_is_reviewer`)

A per-nest flag (**off** by default; nest Settings → "Creators review their own documents") for the GitHub posture: anyone with write access creates documents, and the person who created a document is the one who approves changes to it.

When it's on, creating a document in a governed nest does two things:

1. **The author is stewarded as a document-scope `reviewer`** of that document — exactly the row an admin would otherwise add by hand (`POST /nests/:id/stewards` with `scope: "document"`, or the `documents:` section of `stewards.yaml`). The nest owner is skipped; they already approve everything.
2. **The first version publishes immediately.** The author is the document's reviewer, so nobody else needs to bless v1. This holds for the owner too: with this on, the owner's own new documents publish at v1 whether or not `allow_self_approve` is on — the two settings are independent, and this one only ever touches v1.

The row is written **before** the publish decision, so v1 only publishes when the author really can approve the next change. If a document-scope row for the author already exists on that id with a lesser role (an admin stewarded the id ahead of time), it is left alone and v1 lands as a draft instead. If the row can't be written, the create fails with nothing written.

Everything after v1 is the ordinary review cycle, and separation of duties is untouched:

| | Who approves |
|---|---|
| A teammate edits the document | The creator (plus any tag- or nest-level reviewer, and admins) |
| The creator edits their own document | Another reviewer — the creator can't approve their own submission |

**Prime wins.** A prime document still lands as a draft: its creator is made its reviewer, but someone else has to approve the first version.

Only **future** creates are affected. Turning it on doesn't steward anyone on existing documents, and turning it off leaves every steward row it created in place — remove them from the Stewards tab like any other. Every create surface participates (the editor, the REST and MCP APIs, and `ctx push` — the pusher authored what they pushed); the derived annotations document is the one exception, since nobody authored it.

Like prime, this only applies to **governed** nests. With stewardship off there is nothing to review, so the flag is inert until you turn stewardship on.

## Who sees what

Governance gates two things: who can **approve**, and who can **read**.

- **Approve gate**: server-side, always on when stewardship is enabled. Non-stewards can't approve.
- **Read gate**: only active in **key mode** (`AUTH_MODE=key`, real user accounts with API keys). In **open mode** — which is the default for a solo/local server — everyone is the same anonymous admin, so read-gating is a no-op.

In key mode, when stewardship is enabled on a nest:
- Node list / single-read / search / query responses are filtered to docs the caller can access
- A non-steward gets an empty list or a 403 on the node they asked for
- The nest **owner** and any resolved **steward (any role)** can read; **super admins** bypass the check

## Server super-admins

Super-admins administer **every** nest on the server without being added per-nest. The effective set is the union of three sources:

- **license** — the PromptOwl account that owns the installed license (always; never revocable)
- **config** — emails in `access.yaml: super_admins` (the bootstrap; edit the file + restart to change)
- **granted** — grants managed from **Teammates → Superadmins** in the UI, or `GET/POST /admin/super-admins` (see `API.md`)

A super-admin can:

- Read every document (bypasses the read gate, even with stewardship enabled)
- Change a nest's visibility (private / org / public)
- Add, remove, and re-role collaborators
- Add, remove, and re-role stewards
- Approve and reject pending versions in any nest's review queue
- Manage the official community sites trusted for SSO auto-login (**Settings → Community sites**, or `GET/POST /admin/community-sites` — see `API.md`)

What a super-admin **cannot** do (owner-only operations):

- Delete a nest
- Transfer ownership

Use this for a small set of platform operators — a CEO, a head of governance, an internal compliance admin — not as a default broad-access mechanism. Day-to-day governance should still flow through per-nest stewards.

## Teams — sharing with a group

Instead of adding people one at a time, you can create a **team** — a reusable,
owner-managed group — and share it onto a nest. Each team member carries a
**role** set on the membership (not on the share), and that role applies on
**every** nest the team is shared to:

| Member role | Nest access | Governance |
|---|---|---|
| **viewer** | read | viewer |
| **editor** | write | editor |
| **admin** | admin | admin |

Key points:

- A member's role is uniform across nests — set it once on the team. To vary
  access per nest, use a different team (or a direct collaborator/steward grant).
- When a user reaches a nest by several paths (a direct collaborator grant **and**
  team membership), the **highest** access wins.
- Sharing a team whose members carry a governance role (viewer/editor)
  **enables stewardship** on the nest — same effect as assigning an individual
  steward. An `admin`-only team is collaborator-style and doesn't.
- Removing a member, deleting the team, or unsharing it **revokes access
  immediately** — there are no per-user rows to clean up.
- Managing a team is gated by your role on it: editor/admin members (and the
  owner) can add people, capped to their own level; admins can also change
  roles and remove members; only the owner can delete the team.

### Importing a team from PromptOwl

If you already run teams in PromptOwl, the Teams page has a **PromptOwl Teams**
tab listing your teams there with their members. Each one has a **Sync** button
that copies it here as a normal team owned by you, instead of you retyping every
member. Members without an account here become invited placeholders, exactly as
if you'd added them by hand.

**The tab only appears if you signed in with PromptOwl** — that sign-in is what
gives this server permission to read your teams. Signing in another way (SSO,
your identity provider, or email and password) means no PromptOwl identity to
read teams for, so the tab isn't offered.

**You can import a team you're an owner or editor of in PromptOwl.** Teams you're
view-only on are listed for reference but can't be imported: the copy would be
yours to control here — rename it, rewrite its roster, share it onto a nest —
and that's more than PromptOwl lets you do with that team. Ask one of its owners
or editors to import it instead.

Already-imported teams are marked **Synced** in that tab, and show a **PromptOwl**
badge in the ContextNest Teams tab. Two things worth knowing before you sync
one again:

- **PromptOwl is the source of truth on every sync.** The roster is reconciled to
  match: roles are reset, and anyone no longer in the PromptOwl team is removed —
  including people you added to this team by hand here. If you need a group that
  differs from PromptOwl, make it a separate team rather than editing an
  imported one.
- **Your PromptOwl access isn't stored on this server.** The connection lives in
  a cookie in your own browser and ends when your session does — this server's
  database never holds anything that can reach your PromptOwl account, so a
  stolen backup of it exposes nothing of yours. The connection is also limited
  to reading your profile and your teams: it cannot chat as you or spend your
  credits. Signing out ends it, and revoking the device in PromptOwl's account
  settings ends it immediately from the other side.

PromptOwl's `User` role — its default membership — maps to **viewer** here, as
does any role this version doesn't recognize; `Owner` maps to admin, and
`Editor`/`Viewer` map across as themselves.

Members see the teams they belong to on the **Teams** page and any team-shared
nest on their dashboard. Manage teams there (create, add/remove members with a
role); share them from a nest's sharing panel. See `API.md` §3a for the endpoints.

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
