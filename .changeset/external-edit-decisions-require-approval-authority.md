---
"@promptowl/contextnest-community": patch
---

Approving or rejecting an external (on-disk) edit now takes the same authority as approving a version of that document: on a governed nest, whoever may approve it; on a nest without stewardship, whoever may edit it. Everyone else gets `403` (or `404` for a document they cannot open), and the editor's external-edit banner no longer offers them Approve and Reject. Separately, the nest middleware now recognises the read-tier review actions (approve, reject, submit-review, cancel-review, comments, annotations, deletion requests, push decisions) only as POSTs to those routes, so a document whose name starts with one of those words takes the same write access as any other document.
