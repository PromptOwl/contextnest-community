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

/** The Connect modal never shows a real key — every snippet carries this
 *  placeholder instead, so a copied snippet is a reusable template. */
export const KEY_PLACEHOLDER = "<paste-your-api-key-here>";

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
    "Call nest_index first to see every nest (name, description, size).",
    "",
    "SEARCH/LIST: Omit `nest` to search across ALL nests at once, or specify a nest to target one.",
    "READS: context_get/context_resolve need a `nest` argument — specify which nest.",
    "WRITES: nest_create (no nest needed), context_create/update/delete/move/submit_review need a `nest`.",
    "",
    "Cite what you use as `nest:id`. Never write without asking me first.",
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
 * A nest name reduced to a plain token: lowercase, dashes, nothing else.
 * Shared by every identifier the Connect modal derives from a nest name — a
 * `ctx` vault alias, an `mcpServers` key, a downloaded file name — so the
 * same nest maps to the same token everywhere.
 */
export function slugify(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "nest"
  );
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
  const a = slugify(alias);
  const auth = openMode ? "" : " --bearer-env CONTEXTNEST_API_KEY";
  return [
    `ctx vault add ${a} --url ${base}/nests/${nestId}/mcp${auth}`,
    `ctx query "#tag" --vault ${a}`,
  ].join("\n");
}

/**
 * The one-shot bootstrap brief for wiring an agent to ONE nest.
 *
 * The status-code branches are the load-bearing part of this text. An agent
 * whose first read fails and is told only to stop, stops; one told which
 * endpoint still answers, recovers. Hence each branch names a concrete next
 * call rather than a diagnosis.
 *
 * Three rules this text has to keep, all of them earned the hard way:
 *   - Never claim a capability the caller's current state contradicts. On an
 *     unlicensed server every non-GET is blocked — writes, MCP and /context
 *     alike — so saying otherwise makes an agent distrust the rest of the
 *     brief, correctly. Every GET this prompt uses stays open, but that is not
 *     true of GETs in general: see `isGovernance` in app.ts for the exceptions
 *     before adding another.
 *   - Any signal a branch dispatches on must be visible in the command that
 *     produces it — hence -w on every curl, not just the first.
 *   - Never tell the agent to add or strip a `nodes/` id prefix. It exists on
 *     structured nests and not on imported ones (see storagePrefix), so the
 *     only portable instruction is to reuse the id exactly as returned.
 *
 * Keyless by construction: the key travels in the environment, never here.
 */
export function nestSetupPrompt(
  nestName: string,
  serverUrl: string,
  nestId: string,
  openMode = false,
): string {
  const base = serverUrl.replace(/\/+$/, "");
  const mcp = `${base}/nests/${nestId}/mcp`;
  // One definition of the auth header, used by every curl in the brief. STEP 1
  // built its own copy with a separate ternary, which is exactly how the two
  // drift apart if the header format ever changes.
  const authHeader = openMode
    ? ""
    : '-H "Authorization: Bearer $CONTEXTNEST_API_KEY" ';
  const auth = openMode ? "" : ` ${authHeader.trimEnd()}`;
  return [
    `Connect to my ContextNest nest "${nestName}" and treat it as my source of truth.`,
    "",
    openMode
      ? null
      : "KEY — it is in the environment variable CONTEXTNEST_API_KEY. If that variable is empty, ask me for it and stop: minting a key needs a credential you do not have yet.",
    openMode ? null : "",
    "RULE — do NOT claim you're connected until a call has returned real documents you can name. If nothing works, tell me which step failed and stop. Never guess, never summarise.",
    "",
    "STEP 1 — read the nest:",
    `    curl -s -w '\\nHTTP_STATUS:%{http_code}\\n' -X POST ${base}/nests/${nestId}/context \\`,
    `      ${authHeader}-H "Content-Type: application/json" \\`,
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
    `           curl -s -w '\\nHTTP_STATUS:%{http_code}\\n' "${base}/nests/${nestId}/export?format=markdown"${auth}`,
    "         If the nest is too big to take in one go, list it and read what you need instead.",
    "         Append the id EXACTLY as the list returned it — for a nest created in the app that",
    "         id already starts with `nodes/`, so the path looks doubled and that is correct; a",
    "         nest imported from a folder has no such prefix. Do not add or strip one yourself:",
    `           curl -s -w '\\nHTTP_STATUS:%{http_code}\\n' "${base}/nests/${nestId}/nodes"${auth}`,
    `           curl -s -w '\\nHTTP_STATUS:%{http_code}\\n' "${base}/nests/${nestId}/nodes/<id-from-the-list>"${auth}`,
    "         Documents back from either call count as connected — the proof is real documents,",
    "         not which endpoint served them. Tell me the server is unlicensed, and note the same",
    "         gate covers every non-GET, so WRITES ARE ALSO UNAVAILABLE until a licence is installed.",
    openMode
      ? null
      : "    401  the key is missing or wrong. Also check you did not send the literal text",
    openMode
      ? null
      : "         `$CONTEXTNEST_API_KEY`: that happens when the command runs without a shell to",
    openMode
      ? null
      : "         expand it, and you must substitute the value yourself. Otherwise ask me for the key.",
    "    403  read the body. JSON with an `error` field is the server refusing you, and it says",
    "         which: a `required_permission` field means my key lacks the tier for that action",
    "         (a read-only key does this on any write); a scope message means the key belongs to",
    "         a different nest. Tell me which one; neither is a network problem.",
    "         A 403 with NO JSON body came from something between you and the server, not from us.",
    // A blocked CONNECT never reaches the server at all, so retrying and
    // re-authenticating are both useless. Cloud sandboxes, CI runners and
    // corporate egress proxies all land here.
    "    that bodyless 403, or no response at all / connection refused / a timeout",
    "         something between you and the server is blocking this — a sandbox or network egress",
    "         policy. Either nothing answered, or a gateway answered instead of ContextNest.",
    "         Do not retry and do not tunnel around it. This one is mine to fix, not yours: ask me",
    "         to add ContextNest as a custom connector in my client (Settings → Connectors), which",
    "         is dialled server-side and is not subject to your egress rules.",
    "",
    "WHAT YOU CAN DO — if step 1 returned 503 this server is unlicensed: read it as above, and",
    "do not attempt writes at all, they are blocked by the same gate. Otherwise this connection",
    "reads, and writes IF my key carries write access — a read-only key reads perfectly well and",
    "is refused on the first write. Assume nothing either way until you have my say-so to try.",
    "Over MCP the write tools are",
    "context_create, context_update, context_move and context_submit_review; over REST it is",
    `POST ${base}/nests/${nestId}/nodes to create, and PATCH that same path with the document's`,
    "id appended to update. Never write, publish or share without asking me first.",
    "",
    `THEN — answer from the nest, cite what you use as \`${nestName}:nodes/<slug>\` (that is the id shape the server returns), and say plainly when something is not covered.`,
    "",
    "LATER, optional, persists across sessions — ASK ME FIRST if setting either of these means",
    "writing my key into a config file on this machine; that is my call, not a step you take in",
    "passing. Both use the same credential:",
    `    an MCP server "contextnest" at ${mcp}${openMode ? "" : " (Bearer header)"}`,
    ...ctxCliConnectSnippet(base, nestId, nestName, openMode)
      .split("\n")
      .map((line) => `    ${line}`),
    "  Both only take effect after you RESTART the session, so neither can prove anything now —",
    "  and both go over MCP, which is POST, so on an unlicensed server (the 503 above) they are",
    "  blocked by that same gate. On an unlicensed server the GET reads are all you have.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Claude Desktop only speaks stdio in `claude_desktop_config.json` — no
 * native http/url/headers transport (that shape is for Claude Code / Cursor,
 * see {@link mcpHttpConfig}). Bridges to the Streamable-HTTP endpoint with
 * `mcp-remote`.
 */
export function claudeDesktopConfig(
  nestName: string,
  mcpUrl: string,
  openMode = false,
): string {
  return JSON.stringify(
    {
      mcpServers: {
        [slugify(nestName)]: {
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            mcpUrl,
            ...(openMode
              ? []
              : ["--header", `Authorization: Bearer ${KEY_PLACEHOLDER}`]),
          ],
        },
      },
    },
    null,
    2,
  );
}

/**
 * Claude Code (the CLI) speaks Streamable HTTP natively and registers a
 * server with one command that it persists itself — no config file to open,
 * no `mcp-remote` bridge (that bridge is only for Claude Desktop, which has
 * no CLI). The one-shot path for Claude Code.
 */
export function claudeCodeCommand(
  nestName: string,
  mcpUrl: string,
  openMode = false,
): string {
  return `claude mcp add --transport http ${slugify(nestName)} ${mcpUrl}${
    openMode ? "" : ` --header "Authorization: Bearer ${KEY_PLACEHOLDER}"`
  }`;
}

/**
 * Native HTTP MCP clients (Cursor, VS Code, Claude Code) configure a server
 * by its url + headers in one JSON stanza — same envelope shape as
 * {@link claudeDesktopConfig}, so one paste lands both the endpoint and the
 * auth placeholder instead of two separate copies spliced together by hand.
 */
export function mcpHttpConfig(
  nestName: string,
  mcpUrl: string,
  openMode = false,
): string {
  return JSON.stringify(
    {
      mcpServers: {
        [slugify(nestName)]: {
          url: mcpUrl,
          ...(openMode
            ? {}
            : { headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` } }),
        },
      },
    },
    null,
    2,
  );
}

/**
 * Whether a server URL is obviously private — loopback, RFC 1918, link-local,
 * CGNAT/Tailscale, or an internal-only name (.local, .internal, .lan, .corp,
 * .home.arpa, or a bare hostname with no dot). Such a host is unreachable
 * from a hosted connector (claude.ai, Claude Desktop/Cowork connectors,
 * ChatGPT): those connect from the vendor's servers, not from the person's
 * machine, so a VPN on the laptop doesn't help. A public name that merely
 * resolves to a private address behind a VPN can't be detected here — the
 * Connect panel says so in words for that case.
 */
export function isPrivateHost(serverUrl: string): boolean {
  let host: string;
  try {
    host = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (!host.includes(".") && !host.includes(":")) return true; // bare intranet name
  if (/\.(local|internal|lan|corp|intranet|home\.arpa)$/.test(host)) return true;
  if (host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith("fe80:")) return true;
  // IPv4-mapped IPv6: URL writes [::ffff:10.0.0.1] as ::ffff:a00:1.
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    host = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  // Decimal, octal and hex IPv4 forms need nothing here: URL already
  // normalizes them to dotted decimal (167772161 and 012.0.0.1 → 10.0.0.1).
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
