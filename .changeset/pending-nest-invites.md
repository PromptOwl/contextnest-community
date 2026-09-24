---
"@promptowl/contextnest-community": minor
---

The Nests page shows a Pending invites card for nests shared with you that you haven't acted on yet. Accept opens the nest; Decline removes your own access to it. New endpoint `POST /me/nests/:nestId/leave` drops the caller's own collaborator row and settles the invite (`left: false` when the access came through a team or ownership).
