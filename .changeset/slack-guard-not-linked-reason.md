---
"@promptowl/contextnest-community": patch
---

Control room → Setup: a nest reader who is in the Slack channel with the same email, but whose account link was refused (for example their email here is not verified, or their account is already linked to another Slack user), no longer shows as both "Not in #channel" and "In #channel but not matched to an account here". They now show once, under "In #channel with the same email, but not linked to their account", with the reason. The binding preview carries this as `absent_readers[].reason: "not_linked"` with `match_reason` (po-1467).
