---
"@promptowl/contextnest-community": patch
---

A single answer from PromptOwl's licensing service can no longer unlicense a working server.

**Suspension now goes through the two-strike window it was designed for.** PromptOwl answers a suspended key with `valid: false` plus `suspended: true`. The server returned that `valid: false` as-is, so the license went invalid on the first strike. The 60s safety poll then saw valid → invalid and ran the full revocation, which logged every user out and deleted the stored key. The 1-hour confirmation window never got to run. A suspension flag now keeps the cached license: nothing changes during the window, and once the suspension is confirmed writes return 503 while reads keep working. A suspension never wipes sessions or deletes the key.

**An explicit rejection is acted on only after three in a row.** Previously the first `valid: false` cleared the cache and dropped the server to unlicensed with no grace: every non-GET returned 503, including MCP. That was stricter than the treatment of an unreachable licensing service. Now a previously valid key keeps serving until PromptOwl rejects it three consecutive times (about 3 minutes at the 60s poll), and any valid answer resets the count. Installing a key (`POST /license/install`) still fails immediately when PromptOwl rejects it. CU-wdqcq01kh5.
