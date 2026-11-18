---
"@promptowl/contextnest-community": patch
---

Task numbering's Start at box now says "Start at must be a number from 1 to 999999999." for 0 (or a number past the limit) and keeps Save disabled. Before, Save went through and the error named the internal setting `task_rules.ticket_start_at`.
