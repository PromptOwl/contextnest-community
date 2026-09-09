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
 * The one-shot bootstrap brief for wiring an agent to ONE nest.
 *
 * Shaped by a 10-run agent experiment (2026-09-09, CU-wdqcq01kh8) rather than
 * judgement. Against an identical failing server, the variant that documented
 * WHAT TO DO WHEN THE FIRST READ FAILS connected 2/2; the variant that said
 * "if it fails, stop" connected 0/2. Hence the status-code branches — they are
 * the load-bearing part of this text, not decoration.
 *
 * Three other findings are baked in. Agents trust MECHANISMS over CLAIMS: told
 * in prose that a connection "reads and writes", 5 of 6 still answered "unsure"
 * about writing, so the write tools are named instead. The key is located
 * (CONTEXTNEST_API_KEY, what the .env download writes) rather than merely asked
 * for — the old copy said "ask me for the key" AND "never in our chat" while
 * offering no other channel, and four runs stopped there. And `push` is gone:
 * it uploads a local folder INTO the nest, a different job, and it was the
 * direct cause of agents concluding the CLI is the only thing that can write.
 *
 * Still keyless in the text — the key travels in the environment, never here.
 */
export function nestSetupPrompt(
  nestName: string,
  serverUrl: string,
  nestId: string,
  openMode = false,
): string {
  const base = serverUrl.replace(/\/+$/, "");
  const mcp = `${base}/nests/${nestId}/mcp`;
  const auth = openMode ? "" : ' -H "Authorization: Bearer $CONTEXTNEST_API_KEY"';
  return [
    `Connect to my ContextNest nest "${nestName}" and treat it as my source of truth.`,
    "",
    openMode
      ? null
      : "KEY — it is in the environment variable CONTEXTNEST_API_KEY. If that variable is empty, ask me for it and stop: you cannot mint one yourself (minting needs a signed-in session).",
    openMode ? null : "",
    "RULE — do NOT claim you're connected until a call has returned real documents you can name. If nothing works, tell me which step failed and stop. Never guess, never summarise.",
    "",
    "STEP 1 — read the nest:",
    `    curl -s -X POST ${base}/nests/${nestId}/context \\`,
    openMode
      ? '      -H "Content-Type: application/json" \\'
      : '      -H "Authorization: Bearer $CONTEXTNEST_API_KEY" -H "Content-Type: application/json" \\',
    "      -d '{\"selector\":\"type:document\",\"hops\":1,\"max_tokens\":2000}'",
    "",
    "  Documents back? You're connected. Name them, then read WHAT YOU CAN DO below.",
    "",
    "  Otherwise the status code tells you which problem you have:",
    // /context is a POST, and every non-GET is license-gated. These two reads
    // are GETs, so they are the only ones that answer on an unlicensed server
    // — which is the state of every trial and every fresh self-host.
    // /export is a GET, so the license gate misses it, and with no selector it
    // returns every accessible document's frontmatter AND body in ONE call —
    // strictly better than list-then-read (1 call vs 1+N) and it sidesteps the
    // doubled-id shape below entirely. The per-document path stays as the
    // escape hatch for a nest too large to swallow whole.
    "    503  the server has no PromptOwl license, which blocks that endpoint. This one is a",
    "         GET, so it still works, and returns every document WITH its text in one call:",
    `           curl -s "${base}/nests/${nestId}/export?format=markdown"${auth}`,
    "         If the nest is too big to take in one go, list it and read what you need instead",
    "         (the id the list returns already starts with `nodes/`, so the path doubles):",
    `           curl -s ${base}/nests/${nestId}/nodes${auth}`,
    `           curl -s ${base}/nests/${nestId}/nodes/nodes/<slug>${auth}`,
    "         Either way, tell me the server is unlicensed.",
    openMode
      ? null
      : "    401  the key is missing or wrong. Ask me for it. Do not retry with a different one.",
    "    403  read the body. JSON with an `error` field is the server refusing you — usually a",
    "         key scoped to a different nest. Tell me which; do not treat it as a network problem.",
    "         A 403 with no JSON body is a gateway, not us — treat it as the next case.",
    // A blocked CONNECT never reaches the server at all, so retrying and
    // re-authenticating are both useless. Cloud sandboxes, CI runners and
    // corporate egress proxies all land here.
    "    no response / connection refused / a timeout",
    "         your environment cannot reach this host — a sandbox or network egress policy is blocking it.",
    "         Do not retry and do not tunnel around it. Tell me, and ask me to add ContextNest",
    "         under Settings → Connectors → Add custom connector instead, which is dialled",
    "         server-side and is not subject to your egress rules.",
    "",
    "WHAT YOU CAN DO — this connection reads AND writes. Over MCP the write tools are",
    "context_create, context_update, context_move and context_submit_review; over REST it is",
    `POST and PATCH on ${base}/nests/${nestId}/nodes. Never write, publish or share without asking me first.`,
    "",
    `THEN — answer from the nest, cite what you use as \`${nestName}:nodes/<slug>\` (that is the id shape the server returns), and say plainly when something is not covered.`,
    "",
    "LATER, optional, persists across sessions — either of these, with the same credential:",
    `    an MCP server "contextnest" at ${mcp}${openMode ? "" : " (Bearer header)"}`,
    ...ctxCliConnectSnippet(base, nestId, nestName, openMode)
      .split("\n")
      .map((line) => `    ${line}`),
    "  Both only take effect after you RESTART the session, so neither can prove anything now.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
