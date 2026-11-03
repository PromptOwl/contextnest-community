---
"@promptowl/contextnest-community": patch
---

More ways to connect. The `/setup` page's "Connect your agent" step now leads with two copyable choices: the Claude Code plugin (`/plugin marketplace add promptowl/contextnest`, `/plugin install contextnest`, `/contextnest:setup`) and, for a local vault, signing in to this server from a terminal with `ctx login <server>` (ctx 3.4+, which names the alias after the host). The nest Connect dialog's CLI tab and the "Connect all my nests" dialog show the same `ctx login` command (not on open-mode servers, nor over plain http off localhost, which ctx refuses), and "Connect all my nests" also lists the plugin. The README's "Connect an agent" section documents terminal sign-in. Every existing option is unchanged.
