---
"@promptowl/contextnest-community": minor
---

Server settings has a **Connecting agents** tab: verified setup steps for nine AI tools, all pointing at the one endpoint that reads across every nest a person can see.

An operator who stands a nest server up gets asked "how do I wire this into <tool>?" by everyone on their team, and every tool spells it differently — a flag on `claude mcp add`, a TOML table for Codex, a YAML block for Hermes, a web form for ChatGPT, Grok and Claude. Nothing in the product answered that, so the answer lived in whatever someone could reconstruct.

The new tab covers Claude (claude.ai and Desktop), ChatGPT, Grok, Perplexity, Claude Code, OpenAI Codex CLI, Hermes, Gemini CLI and Cursor, grouped by chat / command line / editors, with per-harness and copy-all buttons. Every one of them points at the server-level `/mcp` endpoint rather than a per-nest URL, so a person connects once and reads across the public nests plus whatever private nests they have access to — and nothing has to be redone when they are added to another nest.

Two things the panel now says that nothing said before: a **user-level** key is required, because a key scoped to one nest narrows that same endpoint back down to that nest (`nestScope`, `src/auth/middleware.ts`) and looks exactly like the connect-once promise being broken; and each person should use their own key, because a shared key makes all of them the same user to this server. In open mode no credential is mentioned at all. Where a surface only drives an OAuth client and this server has no authorization server to offer it — Perplexity today — the panel says so plainly instead of printing steps that end in a failed connection.

The text is a pure, unit-tested module (`ui/src/lib/agent-connect-docs.ts`), so the invariants are enforced rather than maintained by hand: no harness may render key material, none may render a per-nest URL, and open mode must drop every credential instruction.

`PUBLIC_BASE_URL` is now validated when it is saved. It has to be a plain `http(s)` URL, with no whitespace, quotes or shell characters (`" ' \` \ $ ; | & < > ( ) { }`). Those were previously accepted — the setting was stored after nothing more than a trim — and this value is rendered straight into the snippets above, including a `bash` block and quoted strings in `config.toml`, `config.yaml` and `mcp.json` that people paste verbatim. An admin who set a hostile value could therefore have run commands on the machine of everyone who followed the setup instructions. The panel strips the same characters when it renders, so a value stored before this check cannot reach a snippet either; existing values are not rewritten.
