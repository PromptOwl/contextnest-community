---
"@promptowl/contextnest-community": minor
---

Activity log for a document, a folder, or the nest, for admins. Owners and nest admins get an Activity entry in a document's ⋯ menu (document page and card view), on a folder's row, and in the nest's ⋯ menu. It opens a log of who created, edited, restored, reviewed, commented on, deleted, read, pulled into a search or answer, or exported that document or anything under the folder, newest first, with the agent and whether it came through the web/API or MCP. The log can be filtered to changes, reviews, comments, or reads & pulls, and to one person. Reads, retrievals and exports are now recorded per document (migration 047), throttled to one row per person, document and action per 10 minutes and pruned on the activity-trace retention window. New endpoint: `GET /nests/:id/activity-log`.
