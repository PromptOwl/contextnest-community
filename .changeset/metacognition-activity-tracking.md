---
"@promptowl/contextnest-community": minor
---

Activity tracking for metacognition agents. Workflows → Agents → Activity shows each agent's track record over 7/30/90 days: run outcomes (succeeded, failed, timed out, skipped), tokens and estimated cost, how reviewers judged its proposals (approval rate, pending), comments, the last error, and its recent runs with a link into each trace (`GET /nests/:id/metacognition/:node/stats`). A proposal, comment or access request an agent run produced now carries that run's id (migration 060) and shows "agent run <id>" in the review queue, comment threads and the inbox, opening the trace at `/nest/:id/workflows?run=<id>`. New `RUN_RETENTION_DAYS` (default 0 = keep every run; also in Server settings → Basic) prunes finished runs hourly.
