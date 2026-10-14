---
"@promptowl/contextnest-community": minor
---

Reviewers can fix a submission and approve it in one step instead of sending it back. On a document waiting for review, someone who can both edit and approve it gets an **Edit** button next to Approve / Reject; editing switches Save to **Save & approve**, which publishes the reviewer's fix together with the author's change. The fix is its own version under the reviewer's name, the submission still belongs to the author (separation of duties is unchanged), and the author gets the usual approval notification with the note "Approved with reviewer edits". Not offered on prime documents.

New endpoint `POST /nests/:nestId/nodes/:nodeId/approve-with-edits` (see API.md). STEWARDSHIP.md no longer says the reviewer role can edit — it never could.
