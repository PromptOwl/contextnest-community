---
"@promptowl/contextnest-community": patch
---

**An approval that cannot be published is no longer recorded as approved.** Approving a single document recorded the approval first and published afterwards, so when publishing failed the reviewer still saw a successful approval and the document was pinned as approved without being published — the failure only reached the server log. Approval now publishes first: if the document cannot be published, the reviewer gets an error explaining why and the review stays pending. Successful approvals are unchanged, and single and bulk approval now behave the same way.
