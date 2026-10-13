---
"@promptowl/contextnest-community": patch
---

Superadmins can now see every message the server sends in one place: **Admin → Message log**.

- **What is logged.** Email (with the SMTP/SES message id, and failures recorded as `failed` instead of being swallowed), Slack, Teams and per-nest webhooks (with HTTP status and whether the request went through the egress proxy), in-app inbox notifications (review escalations included), and comments posted by agents.
- **Redacted before storage.** Temporary passwords, sign-in and credential links (query string, fragment, or HTML-escaped), JSON credential fields, Bearer/Basic credentials, `hk_`/`cnst_`/provider/GitHub/AWS keys, and webhook URLs (kept as host plus hash) never reach the table. Bodies are capped at 4 KB.
- **Superadmin only, and audited.** `GET /admin/messages`, `/:id` and `/views` refuse nest owners, nest admins, nest-scoped keys, and every caller in open mode. Each read writes an access-audit row first; if that write fails, the read fails.
- **Settings.** `MESSAGE_LOG_RETENTION_DAYS` (default 30, `0` keeps forever) and `MESSAGE_LOG_STORE_BODIES` (default on), both editable under Settings → Basic → Message log. Messages past retention are pruned whenever the log is read, so they never show after their window.
- Inbox notification emails are now stored lowercased on every path, so a mixed-case address no longer misses its notifications.
