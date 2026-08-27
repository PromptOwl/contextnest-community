/**
 * Pure helpers for the "connect" surfaces — the All-my-nests landing and the
 * Connect-all affordance. Kept React-free so they're unit-testable in this
 * repo's node-only vitest setup (see connect.test.ts).
 *
 * Auth is deliberately out of scope here: nothing in this module mints, stores,
 * or embeds a key. The server-level /mcp endpoint is read-across-every-nest;
 * writing stays per-nest (enforced server-side).
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
export function allNestsChatPrompt(serverBaseUrl: string): string {
  const mcp = serverMcpUrl(serverBaseUrl);
  return [
    "Connect to all my ContextNest nests and treat them as my source of truth.",
    "",
    `Add one MCP server "contextnest" at: ${mcp}`,
    "Authenticate with my ContextNest API key when your client asks for it — never print it back.",
    "",
    "Call nest_index first to see every nest (name, description, size), then pull from",
    "whichever nest fits each question. Search before answering; cite what you use as",
    "`nest:id`; say plainly when something isn't covered.",
    "",
    "This connection reads across nests but doesn't write. Always ask before publishing anything.",
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
 * The one-shot bootstrap brief for wiring an agent to ONE nest. Self-provisioning:
 * a capable agent installs the CLI or adds the MCP server itself, ASKS the user
 * for the key, then connects, orients, and starts. Keyless in the text — the key
 * is handed over by the user when the agent asks.
 */
export function nestSetupPrompt(
  nestName: string,
  serverUrl: string,
  nestId: string,
): string {
  const base = serverUrl.replace(/\/+$/, "");
  const mcp = `${base}/nests/${nestId}/mcp`;
  return [
    `Connect to my ContextNest nest "${nestName}" and treat it as my source of truth. Do as much of the setup yourself as your tools allow; ask me only for the API key.`,
    "",
    "WHAT IT IS — a governed, cited knowledge graph of my context. Read from it; don't guess.",
    "",
    "CONNECT — use whichever fits you:",
    `• MCP client (Claude, Cursor, ChatGPT): add an MCP server named "contextnest" at`,
    `    ${mcp}`,
    "  and send my API key as an Authorization: Bearer header.",
    "• Shell / CLI agent: install and use the CLI —",
    "    npm i -g @promptowl/contextnest-cli",
    `    ctx query --server ${base} --nest ${nestId} "#tag"   # read`,
    `    ctx push  --server ${base} --nest ${nestId}          # push a local vault`,
    "  (the CLI reads CONTEXTNEST_API_KEY from the environment).",
    "• Can't add a server yourself? Tell me exactly what to paste and where.",
    "",
    "KEY — you need my ContextNest API key. Ask me for it (it's in the .env I downloaded); never print it back.",
    "",
    "THEN — call context_overview to learn this nest, search (context_search / context_query) before answering, cite as `nest:id`, remember durable learnings as small linked nodes, and always ask before publishing anything public.",
    "",
    "Confirm when you're connected and summarise what's in the nest.",
  ].join("\n");
}
