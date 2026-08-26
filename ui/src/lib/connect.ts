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
 * The bootstrap brief for wiring an agent to ONE nest: connect, orient, and the
 * standing rules. Keyless — the key is handed over separately by the user.
 */
export function nestSetupPrompt(nestName: string, mcpUrl: string): string {
  return [
    `Connect to my ContextNest nest "${nestName}" and treat it as my source of truth.`,
    "",
    `Add an MCP server "contextnest" at: ${mcpUrl}`,
    "Authenticate with my ContextNest API key when your client asks for it — never print it back.",
    "",
    "First, call context_overview to learn this nest's types, tags and structure. Then search",
    "(context_search / context_query) before answering; open nodes and follow [[links]]; cite as `nest:id`.",
    "Remember durable learnings by writing them back as small, linked nodes.",
    "Always ask before publishing or posting anything publicly.",
  ].join("\n");
}
