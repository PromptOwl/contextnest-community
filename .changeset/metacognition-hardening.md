---
"@promptowl/contextnest-community": minor
---

Metacognition agents: tighter reach, honest failures, less noise.

- **Owner pinned (security).** An agent's owner (`configured_by`) is the person who first set it up and no longer moves to whoever saves the settings. Before, a server admin who changed a cap silently became the owner. The persona's reach is its own: its nest, its configured folders, and grants given to the persona itself. The owner's access is only a ceiling. Ownership moves only when the owner can no longer run the agent, and the save reports `owner_changed: true`.
- **Access requests from agents.** A new `request_access` tool lets a persona ask for read or propose access to a document or folder in its own nest, at most 3 per run. An admin decides it from the inbox. Approving grants the persona, never its owner. Personas can't ask for a whole nest, or in a nest they don't live in.
- **Failures alert.** A run cut off by its wall clock is now `failed` with `stopped_by: "timeout"` instead of `succeeded`. A run lost to a restart is `failed` with `stopped_by: "crashed"`. Every failed run fires `run_failed` to the nest's connectors, including server-executed runs and runs closed over MCP, which never alerted before.
- **Cost survives a crash.** Each model turn writes its usage and estimated cost as a `branch` step (`detail.kind: "turn"`), and a crashed run's trace is rebuilt from them.
- **Less noise.** An agent can't propose a change that is still waiting for review, or one rejected in the last 7 days. Comments get their own cap, `caps.max_comments` (default 5). A scheduled run into a nest where nothing changed since the last successful run, with no feeds or MCP servers, is skipped without calling the model.
- **Learns where it lands.** Its memory now carries its overall approval rate and per-folder verdicts.
- **SSRF fence.** Address literals are judged by range, including IPv4 carried in IPv6 (mapped, compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`), plus `198.18.0.0/15`, multicast, reserved and Teredo. A name like `fd-feeds.com` is no longer mistaken for an IPv6 prefix.
- **Avatar is a glyph.** An emoji or up to 4 letters. URLs are refused, since a remote image would be fetched by every reviewer's browser.
- **Prompt caching** now also covers the run's memory message, not just the system prompt.
