---
"@promptowl/contextnest-community": patch
---

Role changes that raise what someone is billed now ask first. Making a viewer an editor, or an editor an owner, admin or reviewer, shows a confirmation naming the person and their old and new role, and saves only after you confirm. This covers nest sharing, stewards, document and folder shares, teams, access request approvals and superadmins. Apps and scripts confirm with the `X-Confirm-Billing: true` header; MCP agents get a `BILLING_CONFIRMATION_REQUIRED` error and confirm by calling the tool again with `confirm_billing: true`. Creating your own nest still only checks the plan limit.
