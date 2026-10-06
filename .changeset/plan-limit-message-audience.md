---
"@promptowl/contextnest-community": patch
---

**Plan-limit messages are worded for who is asking.** When a role change is refused because the plan is full (`402 plan_limit`), the message now says what is full ("This server's plan includes 5 users (nest owners, admins and reviewers), and all are in use.") and then, for a server admin, "Upgrade the plan from Settings → License to add more." — or, for everyone else, who can't change the plan, "Ask your server admin to add seats."

**Access keys never take a seat.** Seat counting now skips access-key service identities, whatever role they hold on a nest.
