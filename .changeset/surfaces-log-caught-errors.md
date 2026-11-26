---
"@promptowl/contextnest-community": patch
---

Surfaces and Slack: a failure that the code catches now writes one `[surfaces] <step> failed: code=<code> install=… binding=…` line to the server log, where before many were dropped. The code is Slack's error code or the error's class, never its message, so no message text, titles, tokens or secrets reach the log. Best-effort calls (a token revoke, a Home tab refresh, a note) log at warn level; real failures (a lost purge audit row, a failed draft, a fail-closed check) log at error level. Nothing changes in what callers see.
