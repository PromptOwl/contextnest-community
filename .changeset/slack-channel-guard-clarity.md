---
"@promptowl/contextnest-community": patch
---

Control room → Setup: the "Can't listen here" warning is now a one-line summary ("4 people who can read Ops can't be found in #zephyr-ops.") followed by one list per reason (not in the channel, no Slack user with the same email, no account on this server yet), instead of a repeated sentence per person (po-1440). When a reader has no Slack user with the same email, the warning also lists the channel members not matched to an account, with the email Slack has confirmed for them, so a mismatch such as `.com` against `.io` shows at a glance (po-1445). The binding preview carries that as `members_not_readers[].slack_email` (confirmed emails only, unmatched members only, preview only, never stored). Step 2 has a Refresh list button, so a channel Nest was just invited to shows without a page reload.
