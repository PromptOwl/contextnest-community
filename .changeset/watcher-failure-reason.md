---
"@promptowl/contextnest-community": patch
---

Failed agent runs now say why in the Control room ledger instead of "No reason given" (po-1452). The channel watcher and the scheduled metacognition runner classify a failure with the same fixed codes as the Slack judge (po-1407): `model_rejected`, `model_auth`, `model_billing`, `model_rate_limited`, `model_timeout`, `model_error`, `nest_read_failed`, plus `server_stopped` for a run the server stopped under. The code goes on `runs.reason_code`, which is what the ledger reads; the trace also keeps the HTTP status. `closeRun()` takes an optional `reasonCode` that only server closers set; the REST, MCP and agent-event close paths are unchanged. The watcher's log line is now `[watch] run <id> in <nest> #<channel> failed: <class> reason=<code> status=<http>` and never carries the error message, which can contain a key or chat text.
