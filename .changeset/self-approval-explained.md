---
"@promptowl/contextnest-community": patch
---

Authors now learn why they can't approve their own submission, and who can.

- **Your own pending document.** The banner says "You can't approve your own changes. A steward or admin on this nest must approve." and names who can approve it. When nobody else can (the common single-user nest), it says so and points to adding a reviewer steward or turning on "Auto-publish owner & admin edits". A nest owner gets a link that opens Nest settings directly; it isn't offered on prime documents, where self-approve never applies.
- **Submitting with no approver.** Submit for review warns when nobody else can approve the document.
- **Review Queue card.** "(1 pending total, 1 outside your scope)" now reads "(1 you submitted — someone else must approve it)", and other reviewers' items read "N assigned to other reviewers".
- **New endpoint.** `GET /nests/:nestId/nodes/:nodeId/approvers` lists who besides the caller could approve the caller's submission, using the same check as approve. See API.md.
