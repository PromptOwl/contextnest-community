---
"@promptowl/contextnest-community": minor
---

**Plan limits and own model keys in the UI.** Settings → License shows the pricing plan, users and editors against the plan's caps, the Account Owner cap, and a **Manage plan** button that opens this key's page on PromptOwl (`GET /admin/license` now returns `manage_url`, which carries only the key's last four characters). When a role change is refused because of the plan (`402 plan_limit`), the dialog shows why and admins also get a prompt to manage their plan. Without the `byok` licence feature, Settings shows that models are supplied by PromptOwl on the plan's credits in place of the Anthropic key and gateway fields (a stored key can still be cleared), and the workflow run-key prompt no longer asks for a key the server would refuse. `/health` and `/admin/settings` report `byok_available`.
