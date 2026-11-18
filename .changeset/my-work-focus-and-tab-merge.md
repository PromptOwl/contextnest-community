---
"@promptowl/contextnest-community": minor
---

My Work is organized around what needs you. Approvals sit first and Tasks second, so neither is pushed below a long list. Tasks show open ones by default and filter by status (Open, Done, All), stage, priority, due date and text; the most pressing (urgent or overdue) come first and the list shows the top six with "Show all". Mentions and notifications follow; "Waiting on others" is folded until opened. A task counts as finished when it has a completion stamp or carries one of its nest's done tags, so a task closed by tag through an agent or a file sync no longer stays in the open list or the My Work count. `GET /me/work` gives each assigned task its `tags`, and takes `?assigned_done=1` to also list finished tasks (marked `done`, after the open ones); the badge, the urgent count and MCP `context_my_work` still count open work only.

The nest page has two fewer tabs. Overview is part of Documents (the description and facts line sit above the list, and an empty nest still shows its ways to start), and Stewards is part of Collaborators (the steward roster sits under access, with the same permissions as before). `?tab=overview` and `?tab=stewards` links still open the right place.

Saving structure rules no longer fails on a nest that has no settings file (`.context/config.yaml`), such as an imported nest. The first save creates a minimal one, and nothing else in the nest folder is touched. This is a stopgap until the engine creates the file itself.

The review pane (Review tab, My Work and the document editor all open the same one) now shows where a change came from: which agent wrote it and in which session, who submitted it and when, and who sealed the latest version. Tasks get a details card with owner, due date, priority, stage and tags, so the pane is no longer a tall empty box for a task with a short body. The Review queue has Pending approvals and Your review queue counts on top. Approvals lists stay current without a hard refresh: approving with edits and bulk decisions now refresh My Work and the queue, and the lists re-read on focus and every 30 seconds.
