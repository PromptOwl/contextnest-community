---
"@promptowl/contextnest-community": patch
---

**Approve, reject and withdraw make one fewer database query.** Each already loads the pending review before checking the caller's rights, and the rights check then looked up the same review again to find who submitted it. It now reuses the submitter it was handed.
