---
"@promptowl/contextnest-community": patch
---

A bound Slack channel can now be managed from Control room → Setup → Choose channels (po-1437). Each bound row shows its state ("Listening", "Paused by an admin", "Paused: the reader check failed", "Paused: a member removed Nest") and a Manage menu: Pause listening / Resume listening, Move to another nest, Stop listening and History. Pause, Resume, Move and Stop each ask "Why?" and stay disabled until a reason is given; Move checks the new nest with the guard first and changes nothing when it is refused.

Every change goes on the channel's history (new append-only table `surface_binding_history`, migration 101 on SQLite and Postgres): what happened, when, the reason, and the actual person (user id plus their email at the time), so the team can trace who turned listening on or off and why. Pauses and removals nobody chose (the reader check, a member's `/nest leave`, the app uninstalled from Slack's side, the channel archived) are recorded as Nest.

API: new `POST /surfaces/bindings/:id/pause` and `GET /surfaces/bindings/:id/history`; `pause`, `resume` and `DELETE` now require `{ reason }` (422 without); `POST /surfaces/bindings` takes an optional `reason`. An admin pause is `paused_guard` with `paused_by_admin: true` (stored as `pause_reason = 'admin'`), purges and withdraws like any pause, sends no "guard failed" alert, and only Resume (which re-runs the guard) brings it back. The MCP delete/resume tools are unchanged and record "(via MCP, no reason given)".

Disconnect Slack: the confirm dialog now names every channel that stops listening and says each one gets a message. On disconnect, while the bot token still works, Nest posts in each bound channel (not DMs) "Nest was disconnected from this Slack workspace by <name>. It no longer reads or saves anything from this channel. Notes already approved stay in the nest.", and each channel's history records "Slack disconnected by <email>" as that person (user id and email). `DELETE /surfaces/installs/:id` returns `told`, the number of channels that got the message; the MCP disconnect tool records the same with its caller.
