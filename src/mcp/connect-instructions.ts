/**
 * What an MCP client is told when it connects (CU-wdqcq05rn0).
 *
 * The `initialize` result carries an optional `instructions` string, which
 * most clients (Claude Code, Cursor, …) put into the model's system prompt.
 * The server fills it with the nest's operating instructions (CONTEXT.md) and
 * its always-include documents, so the rules arrive whether or not the agent
 * ever calls `context_init`. Delivery is all the server can guarantee: an
 * outside client may still ignore them.
 *
 * Both MCP endpoints are stateless — a server is built per HTTP request — so
 * the text is only resolved for the request that IS an `initialize`; tool
 * calls don't pay for it.
 */
import { getInstructions } from "../nests/instructions-service.js";
import {
  alwaysIncludeDocs,
  newBudget,
  renderStandingInstructions,
  type StandingCaller,
  type StandingSection,
} from "../governance/always-include-service.js";

/** CONTEXT.md can be up to 256 KB; the connect message carries at most this
 *  much of it, cut at a line, with a pointer to `context_init` for the rest. */
export const CONNECT_CONTEXT_MD_CHARS = 24_000;

/** Is this JSON-RPC request (or batch) an `initialize`? Reads a clone, so the
 *  transport still gets the body. Anything unparseable is "no". */
export async function isInitializeRequest(req: Request): Promise<boolean> {
  if (req.method !== "POST") return false;
  try {
    const body = (await req.clone().json()) as unknown;
    const msgs = Array.isArray(body) ? body : [body];
    return msgs.some(
      (m) => !!m && typeof m === "object" && (m as { method?: unknown }).method === "initialize",
    );
  } catch {
    return false;
  }
}

function clipContextMd(text: string): string {
  if (text.length <= CONNECT_CONTEXT_MD_CHARS) return text;
  const cut = text.lastIndexOf("\n", CONNECT_CONTEXT_MD_CHARS);
  return `${text.slice(0, cut > 0 ? cut : CONNECT_CONTEXT_MD_CHARS)}\n\n(CONTEXT.md continues — call context_init for the full text.)`;
}

/**
 * Per-nest endpoint: CONTEXT.md, then the nest's always-include documents the
 * caller can read. A headless access key reads approved documents only, and
 * CONTEXT.md is not a reviewed document (its tool, `context_init`, is closed to
 * those keys), so it gets the standing documents alone. Never throws — a
 * connect must not fail because the instructions couldn't be assembled.
 */
export async function nestConnectInstructions(
  nestId: string,
  caller: StandingCaller,
  opts: { headless: boolean },
): Promise<string | undefined> {
  const parts: string[] = [];
  try {
    if (!opts.headless) {
      const { content } = await getInstructions(nestId);
      if (content.trim()) {
        parts.push(`# Vault Instructions (CONTEXT.md)\n\n${clipContextMd(content.trim())}`);
      }
    }
    const set = await alwaysIncludeDocs(nestId, caller);
    const block = renderStandingInstructions([{ set }], {
      fetchHint: opts.headless ? "read them with context_get" : "read them with context_get or context_init",
    });
    if (block) parts.push(block);
  } catch (err) {
    console.error(`[mcp] ${nestId}: connect instructions unavailable`, err);
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

/**
 * Server-wide endpoint: every readable nest's always-include documents under
 * ONE budget, nests in name order, plus a pointer to the per-nest endpoint's
 * `context_init` (which this endpoint doesn't have). Once the budget is full
 * the remaining nests aren't resolved at all — the count says so — which keeps
 * a connect cheap for someone who can read hundreds of nests.
 */
export async function serverConnectInstructions(
  nests: Array<{ id: string; name: string }>,
  caller: StandingCaller,
  baseUrl: string,
): Promise<string | undefined> {
  const ordered = [...nests].sort(
    (a, b) => a.name.localeCompare(b.name, "en") || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const budget = newBudget();
  const sections: StandingSection[] = [];
  let unchecked = 0;
  for (const n of ordered) {
    if (budget.full) {
      unchecked++;
      continue;
    }
    try {
      sections.push({ nest: n, set: await alwaysIncludeDocs(n.id, caller, budget) });
    } catch (err) {
      console.error(`[mcp] ${n.id}: standing instructions unavailable`, err);
    }
  }
  const lines = [
    "Each nest has operating instructions (CONTEXT.md). Before working in a nest, read them: " +
      `connect to ${baseUrl}/nests/<nest-id>/mcp and call context_init (nest_index lists the ids).`,
  ];
  const block = renderStandingInstructions(sections, {
    heading: "Standing instructions",
    fetchHint: "read them with context_get and the nest argument",
  });
  if (block) lines.push("", block);
  if (unchecked) {
    lines.push(
      "",
      `The size budget filled before ${unchecked} more nest${unchecked === 1 ? "" : "s"} could be checked for standing instructions — connect to a nest's own endpoint to receive its full set.`,
    );
  }
  return lines.join("\n");
}
