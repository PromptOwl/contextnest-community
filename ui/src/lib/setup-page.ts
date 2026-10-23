/**
 * The public /setup page that `ctx setup` opens: pick the vault options here,
 * the CLI runs `ctx init` with them. Pure, so it unit-tests in node.
 *
 * Hand-off, the OAuth loopback pattern (RFC 8252): the CLI listens on
 * 127.0.0.1 and opens /setup?cb=<loopback url>&state=<nonce>. Submit is a
 * top-level navigation to cb — not a fetch, which Chrome's Local Network
 * Access would gate behind a permission prompt. The CLI checks state, then
 * redirects back to /setup?done=1 for the connect steps.
 *
 * The CLI is the trust boundary: it re-validates every field. This side only
 * refuses a cb that is not loopback, so the page can never post to a host.
 */
import { HARNESSES, renderHarnessDoc } from "./agent-connect-docs";

export interface SetupChoices {
  /** local: `ctx init` a vault here. cloud: `ctx login` to a hosted server and register its nests. */
  mode: "local" | "cloud";
  /** cloud only: the server's base URL. */
  server: string;
  name: string;
  alias: string;
  description: string;
  layout: "structured" | "obsidian";
  /** "" = empty vault. */
  starter: string;
  /** Agent tool ids for the instruction files `ctx init` writes. */
  tools: string[];
  encrypted: boolean;
  setDefault: boolean;
}

// ponytail: mirrors packages/cli/src/starters (ContextNest repo); the CLI
// rejects an id it does not know, so drift fails loudly in the terminal.
export const STARTERS = [
  { id: "developer", name: "Developer / Engineering", description: "Architecture decisions, coding standards, and project knowledge for engineering teams" },
  { id: "personal", name: "Personal / Second Brain", description: "Ideas, decisions, learning, and reference material — no codebase required" },
  { id: "executive", name: "Executive / Leadership", description: "Strategy, operations, and leadership vault for senior leaders" },
  { id: "analyst", name: "Analyst / Research", description: "Methodologies, source catalogs, and report templates for research roles" },
  { id: "team", name: "Team / Organization", description: "Shared processes, team handbook, and onboarding guides" },
  { id: "sales", name: "Sales / Revenue", description: "Objection handling, competitive intelligence, and enablement" },
] as const;

// Mirrors detectAgentTools (packages/cli/src/agent-tools.ts).
export const TOOLS = [
  { id: "claude", name: "Claude Code", hint: "CLAUDE.md" },
  { id: "cursor", name: "Cursor", hint: ".cursorrules" },
  { id: "windsurf", name: "Windsurf", hint: ".windsurfrules" },
  { id: "copilot", name: "GitHub Copilot", hint: ".github/copilot-instructions.md" },
  { id: "gemini", name: "Gemini CLI", hint: "GEMINI.md" },
] as const;

/** The registry's ALIAS_PATTERN. It also keeps the alias safe inside the shell commands below. */
export const ALIAS_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const DEFAULT_CHOICES: SetupChoices = {
  mode: "local",
  server: "",
  name: "My Context Nest",
  alias: "my-nest",
  description: "",
  layout: "structured",
  starter: "developer",
  tools: ["claude"],
  encrypted: false,
  setDefault: true,
};

const LOOPBACK_CB = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/callback$/;

/** The CLI's callback URL, or null when the page was opened by hand or cb is not loopback. */
export function loopbackCallback(cb: string | null): string | null {
  return cb && LOOPBACK_CB.test(cb) ? cb : null;
}

/**
 * Agent tools `ctx setup` found on this computer, from `#detected=a,b`. The
 * fragment never reaches the server, so the server cannot log what is
 * installed. null when the page was not opened by `ctx setup`.
 */
export function detectedTools(hash: string): string[] | null {
  const raw = new URLSearchParams(hash.replace(/^#/, "")).get("detected");
  if (raw === null) return null;
  const known: string[] = TOOLS.map((t) => t.id);
  return raw.split(",").filter((t) => known.includes(t));
}

export function callbackUrl(cb: string, state: string, choices: SetupChoices): string {
  const q = new URLSearchParams({ state, config: JSON.stringify(choices) });
  return `${cb}?${q}`;
}

/** POSIX single-quote: the only quoting with no special characters inside. */
function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `ctx init` line a visitor without `ctx setup` can paste. */
export function initCommand(c: SetupChoices): string {
  const parts = ["ctx init", "--name", sh(c.name), "--layout", c.layout];
  if (ALIAS_PATTERN.test(c.alias)) parts.push("--vault", c.alias);
  if (c.description) parts.push("--description", sh(c.description));
  if (c.starter) parts.push("--starter", c.starter, "--tools", c.tools.length ? c.tools.join(",") : "none");
  if (c.encrypted) parts.push("--encrypted");
  if (c.setDefault) parts.push("--set-default");
  return parts.join(" ");
}

/**
 * A cloud server's origin, or null. https only, except loopback for local
 * testing. The origin has no quote, space or shell character, so it is safe
 * inside the commands below.
 */
export function cloudServer(input: string): string | null {
  try {
    const u = new URL(input.trim());
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The `ctx login` line a visitor without `ctx setup` can paste. */
export function loginCommand(c: SetupChoices): string {
  const parts = ["ctx login", cloudServer(c.server) ?? "<server url>", "--as", ALIAS_PATTERN.test(c.alias) ? c.alias : "<alias>"];
  if (c.setDefault) parts.push("--set-default");
  return parts.join(" ");
}

export interface ConnectGuide {
  id: string;
  name: string;
  /** Markdown, one numbered step per line. */
  steps: string;
}

/** Steps to connect a local vault to each agent. `vault` is an alias or a placeholder. */
export function connectGuides(vaultAlias: string): ConnectGuide[] {
  const v = ALIAS_PATTERN.test(vaultAlias) ? vaultAlias : "<vault alias or path>";
  const mcpJson = [
    "```json",
    "{",
    '  "mcpServers": {',
    '    "contextnest": { "command": "contextnest-mcp", "args": ["' + v + '"] }',
    "  }",
    "}",
    "```",
  ].join("\n");
  const install = "Install the MCP server once: `npm i -g @promptowl/contextnest-mcp-server`.";
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      steps: [
        "**Option A — plugin (recommended).** The plugin retrieves vault context on each prompt and offers to capture new knowledge.",
        "",
        "1. Start Claude Code in your project: `claude`.",
        "2. Add the marketplace: `/plugin marketplace add promptowl/contextnest`.",
        "3. Install the plugin: `/plugin install contextnest`.",
        `4. When it asks for **Pinned vault**, enter \`${v}\` (or leave it empty to use every registered vault).`,
        "5. Restart Claude Code. The session start shows a Context Nest vault overview.",
        "",
        "**Option B — MCP server only.**",
        "",
        `1. ${install}`,
        `2. Register it: \`claude mcp add contextnest -- contextnest-mcp ${v}\`.`,
        "3. In Claude Code, type `/mcp`. The list shows `contextnest` as connected.",
      ].join("\n"),
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      steps: [
        `1. ${install}`,
        "2. Open **Settings → Developer → Edit Config**. This opens `claude_desktop_config.json`.",
        "3. Add this block (merge it into `mcpServers` if the file already has one):",
        "",
        mcpJson,
        "",
        "4. Quit and reopen Claude Desktop. The tools menu lists `contextnest`.",
      ].join("\n"),
    },
    {
      id: "cursor",
      name: "Cursor",
      steps: [
        `1. ${install}`,
        "2. Create `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for every project).",
        "3. Add this block:",
        "",
        mcpJson,
        "",
        "4. Open **Cursor Settings → MCP**. `contextnest` shows a green dot.",
      ].join("\n"),
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      steps: [
        `1. ${install}`,
        `2. Register it: \`gemini mcp add contextnest -- contextnest-mcp ${v}\`.`,
        "3. Start `gemini` and type `/mcp`. The list shows `contextnest`.",
      ].join("\n"),
    },
    {
      id: "codex",
      name: "OpenAI Codex CLI",
      steps: [
        `1. ${install}`,
        `2. Register it: \`codex mcp add contextnest -- contextnest-mcp ${v}\`.`,
        "3. Start `codex` and type `/mcp`. The list shows `contextnest`.",
      ].join("\n"),
    },
    {
      id: "other",
      name: "Any other MCP client",
      steps: [
        `1. ${install}`,
        `2. Configure a **stdio** server with command \`contextnest-mcp\` and argument \`${v}\`.`,
        "3. Most clients take the same JSON shape:",
        "",
        mcpJson,
        "",
        "4. Restart the client and check that it lists the `context_*` tools.",
      ].join("\n"),
    },
  ];
}

/** Where the page parks the choices across the round trip to the CLI. */
export const CHOICES_KEY = "cn_setup_choices";

/**
 * Steps to connect a cloud server to each agent. Claude Code can ride the
 * `ctx login` alias through the plugin; every other harness is the same
 * per-harness doc the server's own Settings panel shows (agent-connect-docs).
 */
export function cloudGuides(server: string, vaultAlias: string): ConnectGuide[] {
  const origin = cloudServer(server) ?? "https://<your server>";
  const v = ALIAS_PATTERN.test(vaultAlias) ? vaultAlias : "<alias>";
  const key = [
    `1. Sign in at [${origin}](${origin}) and open **Connect**. Create a user-level API key.`,
    `2. Put it in your shell profile: \`export CONTEXTNEST_API_KEY=cnst_…\`. Do not paste the key into a config file you commit.`,
    "3. Then:",
    "",
  ].join("\n");
  return [
    {
      id: "claude-code-plugin",
      name: "Claude Code (plugin)",
      steps: [
        "The plugin uses the `ctx` CLI and the key that `ctx login` saved. You need no API key here.",
        "",
        "1. Start Claude Code: `claude`.",
        "2. Add the marketplace: `/plugin marketplace add promptowl/contextnest`.",
        "3. Install the plugin: `/plugin install contextnest`.",
        `4. When it asks for **Pinned vault**, enter \`${v}\` (or leave it empty to use every registered vault).`,
        "5. Restart Claude Code. The session start shows the nests on the server.",
      ].join("\n"),
    },
    ...HARNESSES.map((h) => ({
      id: h.id,
      name: h.name,
      steps: (h.support === "header" ? key : "") + renderHarnessDoc(h, { serverUrl: origin }),
    })),
  ];
}
