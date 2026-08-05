---
"@promptowl/contextnest-community": minor
---

Prime documents: a per-document and per-tag review gate, so a nest no longer
has to choose between reviewing everything and reviewing nothing. A **prime**
document always goes through draft → pending → approved — it is the one thing
`allow_self_approve` does not bypass, so even an owner's edit to the sales
playbook lands as a draft.

Whether a document is prime resolves in the existing steward scope order,
**document → tag → nest**: a Prime switch in the document editor (owner/admin
only, where `false` exempts one doc from an otherwise-prime tag), then the
nest's configurable prime tags (`prime-document` by default), then not prime.
A new per-nest `prime_only_review` setting flips a governed nest's default to
self-publish so only prime documents queue for review; it is off by default, so
existing nests keep their current posture on upgrade. Prime documents carry a
badge in the nest's document list, and both settings are exposed on
`GET`/`PATCH /nests/:id/settings` alongside `prime` on node create/update.
