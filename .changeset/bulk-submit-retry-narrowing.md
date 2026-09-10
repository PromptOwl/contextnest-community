---
"@promptowl/contextnest-community": patch
---

A partly-failed bulk submit for review now retries only the drafts that failed. The dialog previously kept the full original selection, so a retry resubmitted documents already in review and reported them as failures.
