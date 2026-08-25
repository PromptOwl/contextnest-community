---
"@promptowl/contextnest-community": patch
---

Resolve nest permissions in one query instead of six.

Every node read, every MCP tool call and every dashboard card resolves the
caller's permission, and `resolveNestPermission` did it a query at a time: the
nest row, the caller's email, the collaborator row, the steward row, the shared
teams, then one query **per team**. `isPublicReader` then asked the same
questions over again for its own answer. Three of those round trips were the
identical `SELECT email FROM users` — the license-admin check ran its own copy.

Both now derive from `resolveNestAccess`, a single statement that left-joins the
caller, their collaborator row, and existence probes for a steward row and a
share grant onto the nest row. With the caller's email in hand, both admin
checks (`isLicenseAdminEmail`, `isSuperAdmin`) are pure functions over it and
cost nothing. Team membership can't be joined — it lives as JSON in
`teams.members` — but `shared_teams` rides along on the same row, and the
per-team loop became one `IN (…)` query, consulted only when the answer isn't
already settled at admin/owner.

Measured, collaborator on a private nest and steward on a public one:

| call | before | after |
|---|---|---|
| `resolveNestPermission` (collaborator) | 6 | 1 |
| `resolveNestPermission` (steward, public nest) | 6 | 1 |
| `isPublicReader` (steward, public nest) | 5 | 1 |

The middleware and the nest routes now read `hasGrant` off that same row rather
than issuing their own lookup, so `hasAnyGrant` is gone; `effectiveAccess`
returns the facts alongside the permission so the nest list and single-nest
handlers stop re-resolving to answer "is this caller grant-only?".

No policy change: resolution order, the highest-wins merge across
collaborator/team/steward/public sources, the anon-commons rule and the `admin`
short-circuit all behave exactly as before, and `resolveNestPermission` /
`isPublicReader` keep their signatures for their ~40 call sites. A new
`test/nest-access-resolution.test.ts` pins the merge per caller shape — owner,
collaborator, steward, grantee, stranger, public reader, missing nest — and
asserts both wrappers still agree with the fetch they now share.
