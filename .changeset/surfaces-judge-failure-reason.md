---
"@promptowl/contextnest-community": patch
---

A Surfaces listener window whose judge run fails now says why (po-1407). The Control room ledger row reads "Run failed" with a plain reason (the model key was refused, the model is rate-limited, timed out or refused the request, Slack or the nest couldn't be read, …) in place of "No reason given"; the window gets a failed run the trace can follow, and the ledger MCP tools return the same `reason_code`. The server log line names the error class, the reason code and the HTTP status, never the error message. The judge also stops failing on current Claude models: they reject `temperature`, so a model that refuses it is now called at its default.
