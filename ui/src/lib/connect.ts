/**
 * Pure helpers for the "connect" surfaces — the All-my-nests landing and the
 * Connect-all affordance. Kept React-free so they're unit-testable in this
 * repo's node-only vitest setup (see connect.test.ts).
 *
 * Auth is deliberately out of scope here: nothing in this module mints, stores,
 * or embeds a key. The server-level /mcp endpoint reads across every nest the
 * caller can see and carries two bootstrap writes (nest_create,
 * context_create) — see src/mcp/server-routes.ts. Prompts must not claim it is
 * read-only.
 *
 * `openMode` mirrors AUTH_MODE=open deployments, where no key exists: the
 * generated prompts must not tell an agent to send an Authorization header or
 * ask the user for a credential that does not exist.
 */

export interface NestCountRow {
  document_count?: number | string | null;
}

/** Totals across a user's nests — powers the "your whole brain" summary line. */
export function nestSummary(nests: NestCountRow[]): {
  nestCount: number;
  documentCount: number;
} {
  const documentCount = nests.reduce((sum, n) => {
    const n0 = Number(n.document_count ?? 0);
    return sum + (Number.isFinite(n0) ? n0 : 0);
  }, 0);
  return { nestCount: nests.length, documentCount };
}

/**
 * The server-level MCP endpoint: one connection, read across every nest the
 * caller can see. Tolerant of a trailing slash on the base URL.
 */
export function serverMcpUrl(serverBaseUrl: string): string {
  return `${serverBaseUrl.replace(/\/+$/, "")}/mcp`;
}

/**
 * A copy-paste prompt that turns any agent into a grounded assistant over ALL
 * of the user's nests. Contains no secret — the key is handed over separately,
 * by the user, when their client asks for it.
 */
export function allNestsChatPrompt(
  serverBaseUrl: string,
  openMode = false,
): string {
  const mcp = serverMcpUrl(serverBaseUrl);
  return [
    "Connect to all my ContextNest nests and treat them as my source of truth.",
    "",
    `Add one MCP server "contextnest" at: ${mcp}`,
    openMode
      ? "This server needs no credential — connect directly."
      : "Authenticate with my ContextNest API key when your client asks for it — never print it back.",
    "",
    "Call nest_index first to see every nest (name, description, size), then pull from",
    "whichever nest fits each question. Search before answering; cite what you use as",
    "`nest:id`; say plainly when something isn't covered.",
    "",
    "This connection is read-first: it can also create a new nest or a new document",
    "(nest_create, context_create). Never write, publish, or share anything without asking me first.",
  ].join("\n");
}

/**
 * Contents of a downloadable `.env` handed to the user at key-reveal time — the
 * one moment the key exists in the clear. Includes the server URL, the key, and
 * (when known) the nest id. Leads with a do-not-commit warning.
 */
export function envFileContents(opts: {
  serverUrl: string;
  apiKey: string;
  nestId?: string;
}): string {
  const { serverUrl, apiKey, nestId } = opts;
  return [
    "# ContextNest — keep this secret. Do not commit this file.",
    `CONTEXTNEST_SERVER=${serverUrl.replace(/\/+$/, "")}`,
    nestId ? `CONTEXTNEST_NEST=${nestId}` : null,
    `CONTEXTNEST_API_KEY=${apiKey}`,
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * A grounded-assistant prompt scoped to ONE nest — paste into Hootie, a Claude
 * Project, or a custom GPT to turn it into a subject assistant over this nest.
 * Carries no secret.
 */
export function nestChatPrompt(nestName: string, description?: string): string {
  const about = description?.trim()
    ? ` on ${description.trim().toLowerCase()}`
    : "";
  return [
    `You are my assistant for the "${nestName}" nest — my governed knowledge base${about}. Treat it as the source of truth.`,
    "",
    "- When I ask something this nest could cover, SEARCH it first and answer from what you find; cite what you use as `nest:id`.",
    "- If the nest doesn't cover it, say so plainly — don't invent. Offer to add it if it's worth remembering.",
    "- If my question is ambiguous, ask one clarifying question first.",
    "- Never publish or share anything publicly without asking me first.",
    "",
    `Start by telling me what "${nestName}" covers, then ask what I want to dig into.`,
  ].join("\n");
}

/**
 * A `ctx` vault alias must be a plain token; nest names are free text. Same
 * shape the Connect modal uses for file names: lowercase, dashes, nothing else.
 */
function ctxAlias(raw: string): string {
  const alias = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return alias || "nest";
}

/**
 * The `ctx` CLI (2.2+) can read a hosted nest directly: register it once as a
 * vault alias, then `ctx query/read/list --vault <alias>`. The key is never in
 * the command line — `--bearer-env` names the environment variable ctx reads
 * it from (the same CONTEXTNEST_API_KEY the downloadable .env sets). In open
 * mode there is no key, so no `--bearer-env` at all.
 *
 * Pure and key-free by construction: nothing here ever holds key material.
 */
export function ctxCliConnectSnippet(
  serverUrl: string,
  nestId: string,
  alias: string,
  openMode = false,
): string {
  const base = serverUrl.replace(/\/+$/, "");
  const a = ctxAlias(alias);
  const auth = openMode ? "" : " --bearer-env CONTEXTNEST_API_KEY";
  return [
    `ctx vault add ${a} --url ${base}/nests/${nestId}/mcp${auth}`,
    `ctx query "#tag" --vault ${a}`,
  ].join("\n");
}

/**
 * The one-shot bootstrap brief for wiring an agent to ONE nest. Self-provisioning:
 * a capable agent installs the CLI or adds the MCP server itself, ASKS the user
 * for the key, then connects, orients, and starts. Keyless in the text — the key
 * is handed over by the user when the agent asks.
 */
export function nestSetupPrompt(
  nestName: string,
  serverUrl: string,
  nestId: string,
  openMode = false,
): string {
  const base = serverUrl.replace(/\/+$/, "");
  const mcp = `${base}/nests/${nestId}/mcp`;
  return [
    `Connect to my ContextNest nest "${nestName}" and treat it as my source of truth. Set it up yourself where you can;${openMode ? " it needs no credential." : " ask me only for the API key."}`,
    "",
    "RULE — do NOT claim you're connected until you've pulled LIVE data: prove it by showing the nest's real node count and a few real node titles. If you can't retrieve anything, STOP — don't guess, don't summarise — and give me the manual steps below instead.",
    "",
    "WHAT IT IS — a governed, cited knowledge graph of my context. Read from it; never guess.",
    "",
    "CONNECT — pick what fits you:",
    "• Shell / coding agent (Claude Code, Codex, Cursor): the fastest working read is a direct call —",
    `    curl -s -X POST ${base}/nests/${nestId}/context \\`,
    openMode
      ? '      -H "Content-Type: application/json" \\'
      : '      -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \\',
    "      -d '{\"selector\":\"type:document\",\"hops\":1,\"max_tokens\":2000}'",
    `  You can also add an MCP server "contextnest" at ${mcp}${openMode ? "" : " (Bearer header)"} — but its tools don't load until you RESTART the session, so use the curl above to confirm now.`,
    // The key travels in CONTEXTNEST_API_KEY, never on argv (the CLI README's
    // rule; a --key flag also lands in shell history).
    `  Push a local folder of notes up: ${openMode ? "" : "CONTEXTNEST_API_KEY=<key> "}npx -y @promptowl/contextnest-cli@latest push --server ${base} --nest ${nestId}`,
    "  Or register the nest as a ctx vault (CLI 2.2+) and read it straight from the shell —",
    ...ctxCliConnectSnippet(base, nestId, nestName, openMode)
      .split("\n")
      .map((line) => `    ${line}`),
    "• Claude Desktop / claude.ai / ChatGPT (no shell): you can't connect yourself from chat. Tell me to do this: Settings → Connectors → Add custom connector →",
    openMode
      ? `    URL ${mcp}, then restart.`
      : `    URL ${mcp}  ·  header "Authorization: Bearer <key>", then restart.`,
    openMode ? null : "  Put the key in that config — never in our chat.",
    "",
    openMode
      ? null
      : "KEY — ask me for my ContextNest API key. Put it in the env/config above; don't print it back.",
    openMode ? null : "",
    "THEN (only after the proof above) — search before answering, cite what you use as `nest:id`, remember durable learnings as small linked nodes, and always ask before publishing anything public.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
