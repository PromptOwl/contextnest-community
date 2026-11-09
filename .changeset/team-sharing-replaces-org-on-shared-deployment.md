---
"@promptowl/contextnest-community": minor
---

Team sharing replaces "Organization" on a server that hosts several organizations. With `SHARED_DEPLOYMENT` on, the visibility picker offers "Share with a team…" instead of Organization (a nest that is already org still shows it), the Share dialog and the Collaborators add control open on Teams, and a user with no teams can create one and share the nest in one step. Teams now follow the deployment kind: on a shared deployment a user sees only the teams they own or are on, as before; on a single-organization server every team is listed and a nest admin may share any team. New MCP tool `context_nest_teams` (list, share, unshare) mirrors `/nests/:id/teams`, including `confirm_billing` when a share raises what a member is billed.
