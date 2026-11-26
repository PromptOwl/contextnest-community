---
"@promptowl/contextnest-community": patch
---

Security: Slack and Teams triggers (inbound hooks) refuse every request until the nest has the signing secret, and Slack's URL check is answered only when it is signed. **Before you upgrade:** for each nest with a Slack or Teams trigger, add `SLACK_SIGNING_SECRET` or `TEAMS_WEBHOOK_SECRET` to the nest's Tool environment. A trigger without it answers 401 and starts no run.
