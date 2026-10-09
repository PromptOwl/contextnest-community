---
"@promptowl/contextnest-community": minor
---

**Board: swimlanes, group by assignee or priority, done columns, and assigned-to-you in My Work.**

- **Columns by Assignee or Priority.** Dragging a card across reassigns it or changes its priority, the way Linear's group-by works. "Unassigned" and "No priority" are always there as drop targets. "+ Add task" in a column sets that column's value. On an assignee board you can add a column for someone on the nest who has nothing assigned yet.
- **Swimlanes** by assignee, priority or parent, on any grouping. Lanes collapse. Dragging into another lane updates that field in the same write as the column move. "+ Add task" inside a lane puts the new card in that lane.
- **Done columns.** A nest admin marks a tag column as "done" with the check on its header; `done` is marked by default. A task moved into a done column gets a `completed_at` timestamp, and one moved out is reopened. Done cards show a green check and "done 2h ago". Sub-item chips show progress ("2/5"). A **Completed** display option shows completed cards from the past week or month, all of them, or none.
- **Assigned to you in My Work**, across nests, soonest due first. When someone assigns you a card you get a notification, unless you assigned yourself.
- Setting a field inline on a governed document (priority, assignee, due) now asks first, the same as dragging one.
