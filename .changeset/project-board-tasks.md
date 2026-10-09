---
"@promptowl/contextnest-community": minor
---

**Project boards: tasks, assignees, due dates, priorities, sub-items, and adding cards from the Board.**

- New `task` node type, which **skips review** so board work can move freely. Prime still wins, and turning a governed document into a task still goes through review. Available once the engine includes `task` (`/health` → `type_task_enabled`).
- Any node can carry board fields: `assignee` (someone on the nest's roster), `due`, `priority` (urgent/high/medium/low) and `parent` (sub-items). The server records `assigned_at` and `moved_at`.
- Board cards show priority, due date (red when overdue), sub-item count, last-updated time and the assignee, and you can set each one in place. **+ Add task** sits at the bottom of every column, and the board can be filtered by person ("Only my tasks", "Unassigned") or to tasks only.
- Dragging a governed document asks first ("this lands as a draft that needs review") instead of quietly creating a draft.
