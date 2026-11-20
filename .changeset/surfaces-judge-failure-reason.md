---
"@promptowl/contextnest-community": patch
---

A Surfaces listener window whose judge run fails now says why (po-1407). The Control room ledger row reads "Run failed" with a plain reason (the model account is out of credit, the model key was refused, the model is rate-limited, timed out or refused the request, Slack or the nest couldn't be read, …) in place of "No reason given"; the window gets a failed run the trace can follow, and the ledger MCP tools return the same `reason_code`. The server log line names the error class, the reason code and the HTTP status, never the error message. An out-of-credit model account also sends server admins one notice a day per nest. Separately, the judge no longer fails on models that reject `temperature`: it calls them at their default.
