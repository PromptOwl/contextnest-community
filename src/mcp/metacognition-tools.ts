/**
 * Metacognition over MCP (CU-wdqcq05rqq): list, suggest, preview, configure, run
 * and remove metacognition agents from a harness like Claude, without
 * hand-written REST calls. One operation per tool: preview is the read-only
 * check, configure saves. configure's old dry_run stays for existing callers.
 *
 * Each tool calls the same operation in metacognition/manage.ts that the REST
 * route calls — the agent-document check, parseConfig, the owner pinning, the
 * one-run-at-a-time 409 and the hourly start limit — so the two surfaces can't
 * drift. Errors are those operations' messages, verbatim.
 *
 * Gating, outermost first:
 *  - advertised only when FEATURE_WORKFLOW_PLANE and FEATURE_METACOGNITION are
 *    on (mcp/routes.ts, mcp/server-routes.ts); a call that gets here anyway
 *    with either off is refused as not enabled;
 *  - all six are in MCP_ADMIN_TOOLS: offered only to a person holding a full
 *    credential who owns or administers the nest, never to read-only or
 *    headless keys;
 *  - every call re-checks: no system key, then owner/admin on the nest.
 */
import { AppError, NotFoundError, ValidationError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { summarizeConfig } from "../metacognition/summary.js";
import { listAgents } from "../metacognition/store.js";
import { resolveExportBody } from "../nodes/readable-body.js";
import {
  NOT_ENABLED,
  metacognitionEnabled,
  assertCanManageMetacognition,
  agentView,
  validateAgentConfig,
  configureAgent,
  removeAgent,
  runAgent,
  suggestAgentConfig,
} from "../metacognition/manage.js";
import type { McpToolContext, ToolResult } from "./tools.js";

const AGENT_REF = {
  type: "string",
  description: 'Node id of the agent document, e.g. "nodes/archivist" (context_metacognition_list shows them).',
} as const;

/** The PUT body's fields — also the allow-list of what configure passes to parseConfig. */
const CONFIG_PROPERTIES = {
  persona: { type: "object", description: "{ name, avatar? } — avatar is an emoji or up to 4 letters" },
  scope: {
    type: "object",
    description: '{ read: string[] ([] = whole nest), propose: string[] ([] = comments only, ["*"] = anywhere it reads) }',
  },
  caps: { type: "object", description: "{ max_steps?, max_tokens?, max_seconds?, max_proposals?, max_comments? }" },
  feeds: { type: "array", items: { type: "object" }, description: "[{ name, url }] — public https feeds it reads as untrusted data" },
  mcp_servers: { type: "array", items: { type: "object" }, description: "[{ name, url, allowed_tools: string[], auth_env? }]" },
  model: { type: "string", description: "Model override (default: the nest's Hootie model)" },
  notify: {
    type: "object",
    description: '{ recipients: ("owner"|"reviewers"|member email)[], channels: ("email"|"connectors")[], max_per_run? } — default: nobody',
  },
  enabled: { type: "boolean", description: "false keeps the settings but stops it running (default true)" },
} as const;

const EXAMPLE_BODY = JSON.stringify({
  agent: "nodes/archivist",
  persona: { name: "Archivist", avatar: "🦉" },
  scope: { read: ["gtm", "ops"], propose: ["gtm"] },
  caps: { max_proposals: 5, max_comments: 5 },
});

/** Preview's arguments. configure takes these plus the deprecated dry_run. */
const CONFIG_INPUT = {
  type: "object",
  properties: { agent: AGENT_REF, ...CONFIG_PROPERTIES },
  required: ["agent"],
};

/** The config fields, spelled out once for preview and configure. */
const CONFIG_FIELDS_HELP =
  "Fields (the same body as PUT /nests/:id/metacognition/:node): persona {name, avatar: an emoji or up to 4 letters, never a URL}; " +
  "scope {read: folders it may read, [] = the whole nest; propose: folders it may suggest edits in, inside read — " +
  '[] = no edits, comments only; ["*"] = anywhere it reads}; caps {max_steps, max_tokens, max_seconds, max_proposals, max_comments} ' +
  "(clamped to server limits); feeds [{name, url: public https}]; mcp_servers [{name, url, allowed_tools: [...], auth_env?: MCP_*}]; " +
  "model (default: the nest's); notify {recipients: owner | reviewers | a member's email, channels: email | connectors, max_per_run} " +
  "(default: nobody); enabled (default true). Unknown fields are ignored.";

export const METACOGNITION_TOOL_DEFINITIONS = [
  {
    name: "context_metacognition_list",
    description:
      "List this nest's metacognition agents — agent documents the SERVER runs on its own, as a named persona, " +
      "whose only way to change the nest is a proposal a reviewer approves. Returns the configured agents (each with " +
      "its config and a plain-language summary of what it may do) and the agent documents not set up yet. " +
      "Call this first when the user asks about their metacognition agents or wants to set one up. Owner/admin only.",
    inputSchema: { type: "object", properties: {}, required: [] as string[] },
  },
  {
    name: "context_metacognition_suggest",
    description:
      "Suggest a starting config for an agent document, read off its approved instructions (persona from the title, folders it " +
      "names, whether it should edit or only comment, feed links). One read-only operation: it saves nothing, and fetches nothing, feed links included. " +
      "Returns { config, why, mcp_candidates, instructions }: config passes context_metacognition_preview and context_metacognition_configure as is; " +
      "why explains each filled field; mcp_candidates are MCP links that need allowed_tools named by a person before they go in mcp_servers. " +
      "Use it before preview when setting a new agent up. Owner/admin only.",
    inputSchema: { type: "object", properties: { agent: AGENT_REF }, required: ["agent"] },
  },
  {
    name: "context_metacognition_preview",
    description:
      "Check a metacognition agent config without saving it. One read-only operation: it validates the config against the agent document " +
      "and returns the normalized config plus a plain-language summary. It saves nothing, starts nothing and fetches nothing. " +
      "Show the user the summary, and call context_metacognition_configure only once they confirm. " +
      `${CONFIG_FIELDS_HELP} Owner/admin only. Example: ${EXAMPLE_BODY}`,
    inputSchema: CONFIG_INPUT,
  },
  {
    name: "context_metacognition_configure",
    description:
      "Save a metacognition agent's settings. One write: it turns an agent document into a metacognition agent, or replaces the stored settings of one " +
      "that already is. Saving calls nothing outside the server, but the feeds and MCP servers saved here are what the agent's runs, schedules and hooks then reach. " +
      "The document must be type agent, and the server runs its APPROVED text as the agent's instructions (an unapproved agent document is skipped at run time). " +
      "ALWAYS call context_metacognition_preview first and show the user its summary; save only once they confirm. " +
      `${CONFIG_FIELDS_HELP} The agent never publishes: every change it ` +
      `makes goes to a reviewer. Owner/admin only. dry_run is deprecated, use context_metacognition_preview. Example: ${EXAMPLE_BODY}`,
    inputSchema: {
      ...CONFIG_INPUT,
      properties: {
        ...CONFIG_INPUT.properties,
        dry_run: {
          type: "boolean",
          description:
            "Deprecated: use context_metacognition_preview. Kept for existing callers: true saves nothing and answers as preview does. Must be a JSON boolean.",
        },
      },
    },
  },
  {
    name: "context_metacognition_run",
    description:
      "Start one run of a metacognition agent now. One operation: the server runs it in the background and returns its run_id at once; follow it with " +
      "workflow_run_get { run_id }, and see its track record with workflow_runs_list { agent, agent_stats: true }. " +
      "Side effects: the run calls the model (spending the nest's budget), may fetch the agent's configured feeds, may call its configured MCP servers' allowed tools, " +
      "and may notify the people its owner listed. In the nest it never publishes: it leaves comments, files access requests, and writes draft proposals for a reviewer, " +
      "which replace a document's working copy but not its approved text. It also withdraws the agent's own rejected drafts, deleting a proposed document that was never published. " +
      "Refused while the same agent is already running, and after too many starts in an hour. Owner/admin only.",
    inputSchema: {
      type: "object",
      properties: {
        agent: AGENT_REF,
        inputs: { type: "object", description: "Optional request for this run; the agent treats it as a request to consider, not as instructions" },
      },
      required: ["agent"],
    },
  },
  {
    name: "context_metacognition_remove",
    description:
      "Stop a document being a metacognition agent. The agent document itself stays, as do its past runs and proposals. " +
      "Owner/admin only.",
    inputSchema: { type: "object", properties: { agent: AGENT_REF }, required: ["agent"] },
  },
];

const NAMES = new Set(METACOGNITION_TOOL_DEFINITIONS.map((t) => t.name));
export const METACOGNITION_TOOL_NAMES: ReadonlySet<string> = NAMES;
export const isMetacognitionTool = (name: string): boolean => NAMES.has(name);

/**
 * Can this JSON-RPC body (one message or a batch) use the metacognition tools?
 * Only a tools/list or a call to one of them — the server-level endpoint uses
 * this to skip working out whether to offer them on every other request.
 */
export function requestMayUseMetacognition(body: unknown): boolean {
  // Fail closed: anything unrecognised (junk, an odd encoding) is "no", which
  // only means the tools aren't offered on that request.
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => {
    if (!m || typeof m !== "object") return false;
    const { method, params } = m as { method?: unknown; params?: { name?: unknown } };
    return method === "tools/list" || (method === "tools/call" && isMetacognitionTool(String(params?.name ?? "")));
  });
}

/** An operation's refusal → a tool error carrying its message unchanged.
 *  CONFLICT (409: already running, too many starts this hour) means "try
 *  again later", not "fix the input"; a 5xx is the server's fault, INTERNAL. */
export function metacognitionRefusal(err: unknown): ToolResult {
  if (!(err instanceof AppError)) throw err;
  const code =
    err.statusCode >= 500
      ? "INTERNAL"
      : err.statusCode === 403
      ? "UNAUTHORIZED_ACTION"
      : err.statusCode === 404
        ? err.message === NOT_ENABLED
          ? "CONFIG_ERROR"
          : "DOCUMENT_NOT_FOUND"
        : err.statusCode === 409
          ? "CONFLICT"
          : "VALIDATION_FAILED";
  return { text: err.message, isError: true, data: { code, message: err.message, http_status: err.statusCode } };
}

function agentArg(args: Record<string, any>): string {
  return typeof args.agent === "string" ? args.agent.trim() : "";
}

function configBody(args: Record<string, any>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(CONFIG_PROPERTIES).filter((k) => k in args).map((k) => [k, args[k]]));
}

/** Validate and summarize; never saves. `next` tells the harness how to save. */
async function previewConfig(args: Record<string, any>, ctx: McpToolContext, next: string, dryRun = false): Promise<ToolResult> {
  const v = await validateAgentConfig(ctx.nestId, agentArg(args), configBody(args));
  const summary = summarizeConfig(v.config, { enabled: v.enabled });
  return {
    text: `${dryRun ? "Dry run — nothing" : "Nothing"} saved.\n\n${summary}\n\nShow the user this summary; ${next}.`,
    data: { ...(dryRun && { dry_run: true }), saved: false, node_id: v.nodeId, enabled: v.enabled, config: v.config, summary },
  };
}

export async function runMetacognitionTool(
  toolName: string,
  args: Record<string, any>,
  ctx: McpToolContext,
): Promise<ToolResult> {
  try {
    if (!metacognitionEnabled()) return metacognitionRefusal(new NotFoundError(NOT_ENABLED));
    await assertCanManageMetacognition(ctx.nestId, ctx.userId);
    switch (toolName) {
      case "context_metacognition_list": {
        // The run skips an agent whose document has no approved version, so
        // say which do — a harness should warn before setting up one that
        // would never run.
        const agentDocs = (await ctx.storage.discoverDocuments()).filter(
          (d) => (d.frontmatter.type || "document") === "agent",
        );
        const approved = new Map<string, boolean>(
          await Promise.all(
            agentDocs.map(
              async (d) => [d.id, (await resolveExportBody(ctx.nestId, d.id, d.body || "")) !== null] as const,
            ),
          ),
        );
        const agents = (await listAgents(ctx.nestId)).map((a) => ({
          ...agentView(a),
          instructions_approved: approved.get(a.node_id) ?? false,
          summary: summarizeConfig(a.config, { enabled: a.enabled }),
        }));
        const configured = new Set(agents.map((a) => a.node_id));
        const unconfigured = agentDocs
          .filter((d) => !configured.has(d.id))
          .map((d) => ({
            node_id: d.id,
            title: d.frontmatter.title,
            instructions_approved: approved.get(d.id) ?? false,
            summary: approved.get(d.id)
              ? "Not a metacognition agent yet. Set it up with context_metacognition_preview, then context_metacognition_configure."
              : "Not a metacognition agent yet, and its instructions have no approved version: runs would be skipped until a reviewer approves the document.",
          }))
          .sort((a, b) => a.node_id.localeCompare(b.node_id));
        const notApproved = " — instructions not approved yet, so runs are skipped";
        const lines = [
          agents.length ? "## Metacognition agents" : "No metacognition agents yet.",
          ...agents.map(
            (a) =>
              `- ${a.persona.name} (${a.node_id})${a.enabled ? "" : " — switched off"}${a.instructions_approved ? "" : notApproved}: ${a.summary}`,
          ),
        ];
        if (unconfigured.length) {
          lines.push(
            "",
            "## Agent documents not set up yet",
            ...unconfigured.map((d) => `- ${d.title} (${d.node_id})${d.instructions_approved ? "" : notApproved}`),
          );
        }
        return { text: lines.join("\n"), data: { agents, unconfigured } };
      }
      case "context_metacognition_preview":
        return previewConfig(args, ctx, "call context_metacognition_configure to save it");
      case "context_metacognition_configure": {
        // The PUT body is exactly its own fields: nothing a wrapper adds to the
        // call (nest, client, confirm_billing, …) reaches parseConfig.
        const { dry_run } = args;
        const body = configBody(args);
        // Fail closed: a dry_run of "true" or 1 must never read as "save it".
        if (dry_run !== undefined && typeof dry_run !== "boolean") {
          throw new ValidationError("dry_run must be true or false");
        }
        if (dry_run === true) return previewConfig(args, ctx, "call again without dry_run to save it", true);
        const agent = await configureAgent({
          nestId: ctx.nestId,
          nodeId: agentArg(args),
          body,
          savedBy: await resolveCallerEmail(ctx.userId),
        });
        // Summarized from what was stored, so it describes the saved agent.
        const { persona, scope, caps, feeds, mcp_servers, model, notify, enabled } = agent;
        const summary = summarizeConfig(
          { persona: { name: persona.name, avatar: persona.avatar }, scope, caps, feeds, mcp_servers, model, notify },
          { enabled },
        );
        return {
          text: `Saved ${agent.node_id} as a metacognition agent.\n\n${summary}`,
          data: { dry_run: false, saved: true, agent, summary },
        };
      }
      case "context_metacognition_suggest": {
        const suggestion = await suggestAgentConfig(ctx.nestId, agentArg(args));
        return {
          text: `Suggested config for ${agentArg(args)} — nothing saved.\n\n${JSON.stringify(suggestion, null, 2)}`,
          data: { suggestion },
        };
      }
      case "context_metacognition_run": {
        const started = await runAgent({
          nestId: ctx.nestId,
          nodeId: agentArg(args),
          triggeredBy: await resolveCallerEmail(ctx.userId),
          inputs: args.inputs,
        });
        return {
          text: `Started ${agentArg(args)} (run ${started.run_id}). The server runs it; follow it with workflow_run_get.`,
          data: started,
        };
      }
      case "context_metacognition_remove": {
        await removeAgent(ctx.nestId, agentArg(args));
        return {
          text: `${agentArg(args)} is no longer a metacognition agent. The document stays.`,
          data: { removed: true, node_id: agentArg(args) },
        };
      }
      default:
        return { text: `Unknown metacognition tool: ${toolName}`, isError: true, data: { code: "VALIDATION_FAILED", message: `Unknown metacognition tool: ${toolName}` } };
    }
  } catch (err) {
    return metacognitionRefusal(err);
  }
}
