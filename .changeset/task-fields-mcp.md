---
"@promptowl/contextnest-community": minor
---

Tasks over MCP: `context_create` / `context_update` set `assignee`, `due`, `priority` and `parent` with REST's validation; `context_get` / `context_list` / `context_query` return them; `context_list` and `GET /nodes` filter by `assignee`, `priority` and `due_before`. New `context_task_log` tool (and `POST/GET /nodes/:id/task-log`) registers an agent's interaction on a task, attributed to the user plus the API key and client agent, and shows it in the task's activity timeline. Migration `064_task_activity`.
