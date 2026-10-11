---
"@promptowl/contextnest-community": minor
---

An unlicensed server now accepts writes while it has 10 or fewer users, matching the published Free tier ("free for up to 10 users, on our cloud or your servers"). A small internal deployment can be stood up and trialled without installing a PromptOwl key first. Users means every signed-up account except the anonymous user and access-key service identities; viewers count.

Past 10 users with no valid license, the gate is unchanged: reads work and writes return 503. A server admin is told why: "This server has more than 10 users and no valid PromptOwl license, so writes are disabled. Install a license (POST /license/install) or bring the server back to 10 or fewer users." Everyone else still gets the neutral read-only line. A suspension by PromptOwl still blocks writes regardless of user count.

One helper, `writesAllowed()` in `src/auth/free-tier.ts`, decides this for every write path: REST nest routes (including the governance views behind the same gate), server-level and per-nest MCP, and workflow run writes.
