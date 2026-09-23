/**
 * Per-harness connect instructions for the superadmin Settings panel.
 *
 * WHY THIS EXISTS: an admin who turns a nest server on gets asked "how do I
 * wire this into <tool>?" by every person on their team, and every tool spells
 * it differently — a CLI flag, a TOML table, a YAML block, a web form. The
 * Connect modal answers that for one nest and one user; this answers it for
 * the whole server, in the one place the operator already is.
 *
 * Kept React-free and pure so it unit-tests in this repo's node-only vitest
 * setup, exactly like connect.ts and visibility-confirm.ts.
 *
 * TWO INVARIANTS, both covered by tests:
 *
 * 1. NO KEY MATERIAL. These are instructions, not a credential hand-off. The
 *    key is named (a placeholder, or the env var that carries it) and never
 *    rendered — same rule connect.ts holds.
 * 2. HONESTY ABOUT OAUTH. Some surfaces only drive an OAuth client and will
 *    not accept a static bearer header. This server has no OAuth
 *    authorization server today (`/.well-known/*` 404s — see app.ts), so those
 *    harnesses get a plain "not yet" instead of steps that end in a failed
 *    connection. `support: "oauth-only"` marks them; flip to "header" and
 *    rewrite the body if/when an AS ships.
 *
 * Adding a harness: append one entry to HARNESSES. Add its id to the coverage
 * test so removal is deliberate rather than accidental.
 */

export interface ConnectDocsContext {
  /** The server's public base URL, e.g. https://nest.example.com. */
  serverUrl: string;
  /** AUTH_MODE=open — no credential exists, so none may be mentioned. */
  openMode?: boolean;
}

/**
 * Whether the surface can authenticate against this server as it is today.
 * "header" — takes a static Authorization/Bearer credential.
 * "oauth-only" — drives an OAuth client; blocked until an AS exists.
 */
export type HarnessSupport = "header" | "oauth-only";

export type HarnessKind = "chat" | "cli" | "editor";

export interface Harness {
  id: string;
  name: string;
  kind: HarnessKind;
  /** One line: where the person actually does this. */
  where: string;
  /**
   * Deep link straight to the vendor's own settings page, where one is
   * published. Omitted rather than guessed — a wrong link is worse than the
   * written path, which at least degrades into "look for this menu".
   */
  open?: string;
  /**
   * The vendor page these steps were written from. Vendor UIs get reshuffled
   * (ChatGPT renamed this whole surface in July 2026), so every harness
   * carries the source that settles what the current path is.
   */
  docs: string;
  support: HarnessSupport;
  /** Markdown body. Must never contain key material. */
  body: (ctx: ConnectDocsContext, mcpUrl: string) => string;
}

/**
 * The server-level MCP endpoint — one connection, every nest the caller can
 * see.
 *
 * The URL comes from the admin-editable `public_base_url` and lands in three
 * different syntaxes below: single-backtick markdown code spans, a `bash`
 * block people paste into a terminal, and quoted strings in `config.toml`,
 * `config.yaml` and `mcp.json`. A backtick closes the code span; `$(…)`, `;`,
 * `|` and `&&` execute in the shell block; a quote breaks out of the config
 * strings. That turns "can edit server settings" into code execution on the
 * machine of everyone who follows these instructions.
 *
 * `publicBaseUrlError` (`src/shared/public-base-url.ts`) now refuses these
 * when the setting is saved, but this module is handed a string and cannot
 * assume that — a value stored before that check still exists, and the panel
 * falls back to `window.location.origin` when nothing is configured. So strip
 * here too, at the one point the value enters the module, rather than trying
 * to escape at nine call sites: there is no escaping scheme that is at once
 * correct for shell, TOML, YAML, JSON and markdown. None of these characters
 * are valid in a base URL, so dropping them is lossless for a real one.
 */
function mcpEndpoint(serverUrl: string): string {
  const clean = serverUrl
    .replace(/["'`\\$;|&<>(){}\s]/g, "")
    .replace(/\/+$/, "");
  return `${clean}/mcp`;
}

/**
 * Joins a harness body's markdown lines. The ONLY place that filtering
 * happens, so the nine bodies can't drift apart on it.
 *
 * A body is a list of markdown lines where `null` means "this line does not
 * apply to this deployment" and `""` is a real paragraph separator. Those look
 * alike to `.filter(Boolean)`, which drops both — and losing the blank line
 * silently folds a trailing note into the preceding list item, because
 * CommonMark treats an unindented line right after a list item as a lazy
 * continuation of it. Keep the empty strings; drop only the nulls.
 */
function renderBody(...lines: (string | null)[]): string {
  return lines.filter((l): l is string => l !== null).join("\n");
}

const KEY_PLACEHOLDER = "<your ContextNest API key>";
const KEY_ENV = "CONTEXTNEST_API_KEY";

/**
 * The stock paragraph for a surface that only drives an OAuth client. Says
 * what the admin can do instead, so the panel is never a dead end.
 */
function oauthBlocked(
  ctx: ConnectDocsContext,
  name: string,
  detail: string,
  mcp: string,
): string {
  return [
    `**Not connectable yet.** ${detail}`,
    "",
    ctx.openMode
      ? // Saying "this server authenticates with API keys" would be false here
        // — an open-mode deployment has no credential at all. The blocker is
        // the missing authorization server either way.
        `This server needs no credential at all, but ${name} still wants an OAuth client to authorize against, and this server runs no authorization server to offer it. There is no header field to fall back to either.`
      : `This server authenticates with API keys and does not run an OAuth authorization server, so ${name} has nothing to complete its consent flow against. There is no header field to fall back to.`,
    "",
    `The endpoint it would point at is \`${mcp}\`, so nothing here changes once an authorization server ships.`,
    "",
    "Until then, the workable routes are:",
    "",
    "- Use one of the other harnesses in this panel.",
    "- Or drive the nest through the REST API directly.",
  ].join("\n");
}

export const HARNESSES: Harness[] = [
  // ── Chat surfaces ──────────────────────────────────────────────────────
  {
    id: "claude-desktop",
    name: "Claude (claude.ai and Claude Desktop)",
    kind: "chat",
    where: "Customize → Connectors → Add custom connector",
    open: "https://claude.ai/customize/connectors",
    docs: "https://claude.com/docs/connectors/custom/remote-mcp",
    support: "header",
    body: (ctx, mcp) =>
      renderBody(
        "1. Open **Customize → Connectors** and click **Add custom connector**. On Team and Enterprise plans an Owner adds it once under **Organization settings → Connectors → Add → Custom → Web**; members then find it under **Customize → Connectors** and click **Connect**.",
        `2. Set the MCP server URL to \`${mcp}\`.`,
        ctx.openMode
          ? "3. For **Authentication**, choose **No sign-in** — this server needs no credential."
          : `3. For **Authentication**, choose **No sign-in**, then open **Request headers**, pick the \`authorization\` header and enter \`Bearer ${KEY_PLACEHOLDER}\` as its value. Enter the value only — Claude adds the header name itself and sends the value exactly as typed, so the \`Bearer \` prefix and its trailing space have to be there.`,
        "4. Click **Add**. Authentication settings can't be changed afterwards; changing them means removing the connector and adding it again.",
        ctx.openMode ? null : "",
        ctx.openMode
          ? null
          : "> **Request headers are in beta, and the credential is organization-wide.** If the dialog has no **Request headers** section, your organization doesn't have access yet. Everyone on the connector shares the one credential, so on this surface they all reach this server as the key's owner and see that person's nests. Per-user visibility here needs OAuth, which this server doesn't run yet — for per-user nests today, use one of the command-line harnesses.",
        "",
        "> The MCP client runs on Anthropic's servers, not the user's machine, so this URL must resolve on the public internet and present a valid TLS certificate. A `localhost` or internal-DNS address will not work here.",
      ),
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    kind: "chat",
    where: "Settings → Security and login → Developer mode",
    docs: "https://developers.openai.com/plugins/deploy/connect-chatgpt",
    support: "header",
    body: (ctx, mcp) =>
      renderBody(
        "1. Open **Settings → Security and login** and turn on **Developer mode**.",
        "2. Go to the **Plugins** page and click the **+** button.",
        "3. Give it a name and description you'll recognise in the tools menu later.",
        `4. Under **Connection**, paste the MCP server URL \`${mcp}\` — including the \`/mcp\` path.`,
        "5. Create the connection, then add it from the **tools menu** in a new conversation.",
        "",
        "Developer mode is available on Plus, Pro, Business, Enterprise and Edu — not on the free tier. Public HTTPS is required.",
        ctx.openMode ? null : "",
        ctx.openMode
          ? null
          : "> **This surface may not connect yet.** The connection step takes a URL and discovers the server's own authentication; OpenAI documents no field for a fixed API key or `Authorization` header. If the connection fails asking you to sign in, this server has no OAuth authorization server to offer it — use one of the command-line harnesses instead.",
        "",
        "> ChatGPT renamed this surface in July 2026. Older guides point at **Settings → Connectors → Advanced**, which no longer exists.",
      ),
  },
  {
    id: "grok",
    name: "Grok",
    kind: "chat",
    where: "grok.com/connectors → New Connector → Custom",
    open: "https://grok.com/connectors",
    docs: "https://docs.x.ai/grok/connectors",
    support: "header",
    body: (ctx, mcp) =>
      renderBody(
        "1. Go to **grok.com/connectors** and choose **New Connector → Custom**.",
        `2. Enter the MCP server URL \`${mcp}\`.`,
        ctx.openMode
          ? "3. Leave authentication empty."
          : `3. Complete any authentication the form asks for, supplying \`Bearer ${KEY_PLACEHOLDER}\` where it wants a credential.`,
        "4. Grok discovers the exposed tools and offers them alongside its built-in connectors.",
        "",
        "The server must be reachable over the public internet; Grok has no tunnel of its own.",
        ctx.openMode ? null : "",
        ctx.openMode
          ? null
          : "> xAI documents the connector form but not which credentials it accepts, so the authentication step isn't verified here. If it only offers OAuth, this server has none to offer yet — use a command-line harness instead.",
      ),
  },
  {
    id: "perplexity",
    name: "Perplexity",
    kind: "chat",
    where: "All settings → Connectors (perplexity.ai/account/connectors)",
    open: "https://www.perplexity.ai/account/connectors",
    docs: "https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors",
    support: "oauth-only",
    body: (ctx, mcp) =>
      oauthBlocked(
        ctx,
        "Perplexity",
        "Under **All settings → Connectors**, Perplexity's custom-connector form asks for an OAuth client ID under **Advanced**, over Streamable HTTP, on a Pro, Max or Enterprise plan.",
        mcp,
      ),
  },

  // ── Command line ───────────────────────────────────────────────────────
  {
    id: "claude-code",
    name: "Claude Code",
    kind: "cli",
    where: "one command in any terminal",
    docs: "https://code.claude.com/docs/en/mcp-quickstart",
    support: "header",
    body: (ctx, mcp) =>
      renderBody(
        "```bash",
        ctx.openMode
          ? `claude mcp add --transport http contextnest ${mcp}`
          : `claude mcp add --transport http contextnest ${mcp} \\\n  --header "Authorization: Bearer $${KEY_ENV}"`,
        "```",
        "",
        ctx.openMode
          ? "By default this registers at `local` scope — only you, only this project. Add `--scope user` for every project, or `--scope project` to write `.mcp.json` in the repo; that file is safe to commit."
          : `By default this registers at \`local\` scope — only you, only this project. Add \`--scope user\` for every project, or \`--scope project\` to write \`.mcp.json\` in the repo — that file is safe to commit because it can reference \`\${${KEY_ENV}}\` rather than the value.`,
        "",
        "A session started before the server was added must be restarted; a fresh session picks it up automatically.",
      ),
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    kind: "cli",
    where: "codex mcp add, or ~/.codex/config.toml",
    docs: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
    support: "header",
    body: (ctx, mcp) =>
      renderBody(
        "```bash",
        ctx.openMode
          ? `codex mcp add contextnest --url ${mcp}`
          : `codex mcp add contextnest --url ${mcp} --bearer-token-env-var ${KEY_ENV}`,
        "```",
        "",
        "Or write it into `~/.codex/config.toml` directly:",
        "",
        "```toml",
        "[mcp_servers.contextnest]",
        `url = "${mcp}"`,
        ctx.openMode ? null : `bearer_token_env_var = "${KEY_ENV}"`,
        "```",
        "",
        ctx.openMode
          ? null
          : "Codex reads the token from the environment and sends it as an `Authorization: Bearer` header, so the value never lands in the config file.",
      ),
  },
  {
    id: "hermes",
    name: "Hermes (Nous Research)",
    kind: "cli",
    where: "~/.hermes/config.yaml",
    docs: "https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference",
    support: "header",
    body: (ctx, mcp) =>
      renderBody(
        "```yaml",
        "mcp_servers:",
        "  contextnest:",
        `    url: "${mcp}"`,
        ctx.openMode ? null : "    headers:",
        ctx.openMode ? null : `      Authorization: "Bearer \${env:${KEY_ENV}}"`,
        "    enabled: true",
        "```",
        "",
        ctx.openMode
          ? null
          : `Values support \`\${env:VAR}\` interpolation against \`~/.hermes/.env\`, so put the key in that file as \`${KEY_ENV}\` and keep it out of the YAML.`,
        ctx.openMode ? null : "",
        "A `url` entry speaks Streamable HTTP — set `transport: \"sse\"` only if you need the older one.",
      ),
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    kind: "cli",
    where: "~/.gemini/settings.json",
    docs: "https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md",
    support: "header",
    body: (ctx, mcp) =>
      renderBody(
        "```json",
        "{",
        '  "mcpServers": {',
        '    "contextnest": {',
        `      "httpUrl": "${mcp}"${ctx.openMode ? "" : ","}`,
        ctx.openMode
          ? null
          : `      "headers": { "Authorization": "Bearer ${KEY_PLACEHOLDER}" }`,
        "    }",
        "  }",
        "}",
        "```",
        "",
        "Gemini CLI picks the transport from the property name: `httpUrl` is Streamable HTTP, `url` would be SSE, `command` would be stdio. Use `httpUrl` here.",
      ),
  },

  // ── Editors ────────────────────────────────────────────────────────────
  {
    id: "cursor",
    name: "Cursor",
    kind: "editor",
    where: "~/.cursor/mcp.json (or .cursor/mcp.json in a project)",
    docs: "https://cursor.com/docs/mcp",
    support: "header",
    body: (ctx, mcp) =>
      renderBody(
        "```json",
        "{",
        '  "mcpServers": {',
        '    "contextnest": {',
        `      "url": "${mcp}"${ctx.openMode ? "" : ","}`,
        ctx.openMode
          ? null
          : `      "headers": { "Authorization": "Bearer ${KEY_PLACEHOLDER}" }`,
        "    }",
        "  }",
        "}",
        "```",
        "",
        "Cursor expands variables inside `url` and `headers`, so the key can come from the environment rather than the file.",
      ),
  },
];

/**
 * The harness the panel opens on. HARNESSES is a non-empty literal, but the
 * compiler can't know that from `Harness[]` — naming the default here keeps
 * the non-null assertion in one place instead of at every call site.
 */
export const DEFAULT_HARNESS: Harness = HARNESSES[0]!;

export function harnessById(id: string): Harness | undefined {
  return HARNESSES.find((h) => h.id === id);
}

/** One harness, as a markdown block (no heading — the caller owns that). */
export function renderHarnessDoc(h: Harness, ctx: ConnectDocsContext): string {
  // Appended here rather than in each body so no harness can forget it, and
  // so the copied text carries the links too — these steps get pasted into
  // Slack, where "Settings → Connectors" is a lot less useful than a link.
  const links = [
    h.open ? `[Open the settings page](${h.open})` : null,
    `[${h.name} docs](${h.docs})`,
  ]
    .filter((l): l is string => l !== null)
    .join(" · ");
  return `${h.body(ctx, mcpEndpoint(ctx.serverUrl))}\n\n${links}`;
}

const KIND_HEADINGS: { kind: HarnessKind; heading: string }[] = [
  { kind: "chat", heading: "# Chat" },
  { kind: "cli", heading: "# Command line" },
  { kind: "editor", heading: "# Editors" },
];

/**
 * The whole panel as one markdown document, grouped by kind — chat first,
 * because that is who actually needs written instructions.
 */
export function renderAllHarnessDocs(ctx: ConnectDocsContext): string {
  const mcp = mcpEndpoint(ctx.serverUrl);
  const out: string[] = [
    `**Connect once.** All of these point at the same endpoint — \`${mcp}\` — and that one connection reads across every nest the caller can see: the public ones, plus whatever private nests they have been given access to. There is no per-nest setup, and nothing to redo when someone is added to another nest.`,
    "",
    "What comes back is decided by who the caller authenticates as, not by which tool they are running.",
    "",
    ctx.openMode
      ? "This deployment runs in open mode, so no credential is involved and every caller is the same anonymous user."
      : [
          "Two things to get right about the credential:",
          "",
          "- **Use a user-level key, not a nest-scoped one.** A key scoped to a single nest narrows this endpoint back down to that nest, which looks exactly like the connect-once promise being broken. Mint a user-level key in the Connect dialog.",
          "- **Each person uses their own key.** A key shared across a team makes all of them the same user to this server, so they would all see the key owner's nests instead of their own.",
        ].join("\n"),
    "",
  ];

  for (const { kind, heading } of KIND_HEADINGS) {
    const group = HARNESSES.filter((h) => h.kind === kind);
    if (group.length === 0) continue;
    out.push(heading, "");
    for (const h of group) {
      out.push(`## ${h.name}`, "", `*${h.where}*`, "", renderHarnessDoc(h, ctx), "");
    }
  }

  return out.join("\n").trimEnd() + "\n";
}
