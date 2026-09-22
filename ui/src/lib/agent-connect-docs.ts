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
  support: HarnessSupport;
  /** Markdown body. Must never contain key material. */
  body: (ctx: ConnectDocsContext, mcpUrl: string) => string;
}

/** The server-level MCP endpoint — one connection, every nest the caller can see. */
function mcpEndpoint(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/mcp`;
}

/**
 * The one predicate every harness body filters with.
 *
 * A body is an array of markdown lines where `null` means "this line does not
 * apply to this deployment" and `""` is a real paragraph separator. Those look
 * alike to `.filter(Boolean)`, which drops both — and losing the blank line
 * silently folds a trailing note into the preceding list item, because
 * CommonMark treats an unindented line right after a list item as a lazy
 * continuation of it. Keep the empty strings; drop only the nulls.
 */
function isLine(l: string | null): l is string {
  return l !== null;
}

const KEY_PLACEHOLDER = "<your ContextNest API key>";
const KEY_ENV = "CONTEXTNEST_API_KEY";

/**
 * The stock paragraph for a surface that only drives an OAuth client. Says
 * what the admin can do instead, so the panel is never a dead end.
 */
function oauthBlocked(name: string, detail: string, mcp: string): string {
  return [
    `**Not connectable yet.** ${detail}`,
    "",
    `This server authenticates with API keys and does not run an OAuth authorization server, so ${name} has nothing to complete its consent flow against. There is no header field to fall back to.`,
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
    where: "Settings → Connectors → Add custom connector",
    support: "header",
    body: (ctx, mcp) =>
      [
        "1. Open **Settings → Connectors → Add custom connector**.",
        `2. Set the URL to \`${mcp}\`.`,
        ctx.openMode
          ? "3. Leave authentication empty — this server needs no credential."
          : `3. Open the advanced/auth section and add the header \`Authorization: Bearer ${KEY_PLACEHOLDER}\`.`,
        "4. Save, then **reload the page** — tools do not appear until you do.",
        "",
        "On Team and Enterprise plans only an Owner can add the connector; each member then connects to it individually.",
        "",
        "> The MCP client runs on Anthropic's servers, not the user's machine, so this URL must resolve on the public internet and present a valid TLS certificate. A `localhost` or internal-DNS address will not work here.",
      ]
        .filter(isLine)
        .join("\n"),
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    kind: "chat",
    where: "Settings → Apps & Connectors → Advanced → Developer mode",
    support: "header",
    body: (ctx, mcp) =>
      [
        "1. **Settings → Apps & Connectors → Advanced settings → Developer mode**, toggled on.",
        "2. Back in Apps & Connectors, add a custom connector.",
        `3. Set the URL to \`${mcp}\`.`,
        ctx.openMode
          ? "4. Leave authentication empty."
          : `4. Supply \`Authorization: Bearer ${KEY_PLACEHOLDER}\` as the connector's credential.`,
        "5. The connector appears under **Drafts**; pick it in the composer's Developer mode tool to use it in a conversation.",
        "",
        "Developer mode is available on Plus, Pro, Business, Enterprise and Edu — not on the free tier. Public HTTPS is required.",
      ]
        .filter(isLine)
        .join("\n"),
  },
  {
    id: "grok",
    name: "Grok",
    kind: "chat",
    where: "grok.com/connectors → New Connector → Custom",
    support: "header",
    body: (ctx, mcp) =>
      [
        "1. Go to **grok.com/connectors** and choose **New Connector → Custom**.",
        `2. Enter the MCP server URL \`${mcp}\`.`,
        ctx.openMode
          ? "3. Leave authentication empty."
          : `3. Complete the authentication step with \`Authorization: Bearer ${KEY_PLACEHOLDER}\`.`,
        "4. Grok discovers the exposed tools and offers them alongside its built-in connectors.",
        "",
        "The server must be reachable over the public internet; Grok has no tunnel of its own.",
      ]
        .filter(isLine)
        .join("\n"),
  },
  {
    id: "perplexity",
    name: "Perplexity",
    kind: "chat",
    where: "Settings → Connectors → Custom connector",
    support: "oauth-only",
    body: (_ctx, mcp) =>
      oauthBlocked(
        "Perplexity",
        "Perplexity's custom-connector form asks for an OAuth client ID over Streamable HTTP, on a paid plan.",
        mcp,
      ),
  },

  // ── Command line ───────────────────────────────────────────────────────
  {
    id: "claude-code",
    name: "Claude Code",
    kind: "cli",
    where: "one command in any terminal",
    support: "header",
    body: (ctx, mcp) =>
      [
        "```bash",
        ctx.openMode
          ? `claude mcp add --transport http contextnest ${mcp}`
          : `claude mcp add --transport http contextnest ${mcp} \\\n  --header "Authorization: Bearer $${KEY_ENV}"`,
        "```",
        "",
        ctx.openMode
          ? "Add `--scope project` to write `.mcp.json` in the repo instead of the user-level config; that file is safe to commit."
          : `Add \`--scope project\` to write \`.mcp.json\` in the repo instead of the user-level config — that file is safe to commit because it can reference \`\${${KEY_ENV}}\` rather than the value.`,
        "",
        "A session started before the server was added must be restarted; a fresh session picks it up automatically.",
      ]
        .filter(isLine)
        .join("\n"),
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    kind: "cli",
    where: "`codex mcp add`, or ~/.codex/config.toml",
    support: "header",
    body: (ctx, mcp) =>
      [
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
      ]
        .filter(isLine)
        .join("\n"),
  },
  {
    id: "hermes",
    name: "Hermes (Nous Research)",
    kind: "cli",
    where: "~/.hermes/config.yaml",
    support: "header",
    body: (ctx, mcp) =>
      [
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
          ? "Streamable HTTP is the default transport; no credential is needed."
          : `Values support \`\${env:VAR}\` interpolation against \`~/.hermes/.env\`, so put the key in that file as \`${KEY_ENV}\` and keep it out of the YAML.`,
        "",
        "Streamable HTTP is the default transport — only set `transport: \"sse\"` if you need the older one.",
      ]
        .filter(isLine)
        .join("\n"),
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    kind: "cli",
    where: "~/.gemini/settings.json",
    support: "header",
    body: (ctx, mcp) =>
      [
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
      ]
        .filter(isLine)
        .join("\n"),
  },

  // ── Editors ────────────────────────────────────────────────────────────
  {
    id: "cursor",
    name: "Cursor",
    kind: "editor",
    where: "~/.cursor/mcp.json (or .cursor/mcp.json in a project)",
    support: "header",
    body: (ctx, mcp) =>
      [
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
      ]
        .filter(isLine)
        .join("\n"),
  },
];

export function harnessById(id: string): Harness | undefined {
  return HARNESSES.find((h) => h.id === id);
}

/** One harness, as a markdown block (no heading — the caller owns that). */
export function renderHarnessDoc(h: Harness, ctx: ConnectDocsContext): string {
  return h.body(ctx, mcpEndpoint(ctx.serverUrl));
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
