---
"@promptowl/contextnest-community": minor
---

**Seat limits follow the pricing plan.** Each person now bills once, at their highest role on any nest: nest owners, admins, reviewers and server admins (Account Owners) are users; editors are subscribers; everyone else is a free viewer. A role change that would take the server past its plan is refused with `402` and `{ code: "plan_limit", limit, max }` — making someone a nest owner, admin, reviewer or editor (collaborator, steward, grant, or a team shared onto a nest), and adding a superadmin past the plan's Account Owner count. Free allows 10 users, 1 Account Owner and no editors.

Nothing is taken away: signing up and inviting are never refused, viewers are always free, demotions always work, and a server already over its plan keeps everyone it has. A document's creator being made its reviewer does not count as a reviewer seat.

The license check now reports billed users and subscribers instead of every account, and `GET /admin/license` returns the plan, the subscriber count and cap, and the Account Owner cap alongside the user seats.
