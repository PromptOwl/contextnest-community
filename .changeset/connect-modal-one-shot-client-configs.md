---
"@promptowl/contextnest-community": patch
---

The Connect dialog's client tabs stopped asking for two copies where one would do, and stopped showing two different clients the same block.

**MCP tab is one paste again.** It used to show the endpoint and the `Authorization` header as two separate snippets, each with its own Copy button — a user had to copy both and hand-splice them into their client's config. They're now one `mcpServers` JSON stanza with a single Copy button, the same shape Cursor and VS Code already expect.

**Claude tab and MCP tab no longer look identical.** Merging the MCP tab into one JSON block gave it the same `{ "mcpServers": { ... } }` envelope the Claude tab already used, so the two read as the same content pasted twice, even though they target different transports — Claude Desktop only speaks stdio and bridges through `mcp-remote`, while the MCP tab is direct Streamable HTTP for clients that support it natively. Each snippet is now labelled with the client it's actually for.

**Claude Code gets a one-shot command instead of a file to edit.** The Claude tab only ever showed Claude Desktop's `claude_desktop_config.json`, hand-edited and bridged through `mcp-remote` — but Claude Code (the CLI) registers and persists an MCP server itself, with no file to open. The tab now leads with `claude mcp add --transport http <nest> <url> --header "..."` as the primary path; the file-based Claude Desktop config stays below it as a clearly separate option for the GUI app, which has no CLI.

Key generation is unchanged — still a separate step on the API Keys page, not inlined into the modal, since an account can hold multiple keys and there's no single one to pre-fill here.
