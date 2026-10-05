---
"@promptowl/contextnest-community": minor
---

Agent activity with undo. The Review tab has a new Agent activity view listing every change an agent made to the nest: creates, edits, restores and deletions. Each row shows which agent made the change, under which account, and when. The view can be filtered to one agent or widened to everyone's changes. Each change can be undone in one click. Undo writes the previous version back as a new version, discards an unreviewed draft, or removes a document the agent created. It is refused when the document changed since, when the change is awaiting review, or for deletions, and the reason is shown next to the button. Owners, admins and reviewers only. New endpoints: `GET /nests/:id/agent-activity` and `POST /nests/:id/agent-activity/undo`. Deletions now record which agent made them (migration 046).
