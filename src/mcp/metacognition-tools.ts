/**
 * Metacognition over MCP (CU-wdqcq05rqq): list, configure (with a dry run),
 * run and remove metacognition agents from a harness like Claude, without
 * hand-written REST calls.
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
 *  - all four are in MCP_ADMIN_TOOLS: offered only to a person holding a full
 *    credential who owns or administers the nest, never to read-only or
 *    headless keys;
 *  - every call re-checks: no system key, then owner/admin on the nest.
 */
import { AppError, NotFoundError, ValidationError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { summarizeConfig } from "../metacognition/summary.js";
import { listAgents } from "../metacognition/store.js";
import {
  NOT_ENABLED,
  metacognitionEnabled,
  assertCanManageMetacognition,
  agentView,
  validateAgentConfig,
  configureAgent,
  removeAgent,
  runAgent,
} from "../metacognition/manage.js";
import { METACOGNITION_INPUT_SCHEMAS } from "../metacognition/schemas.js";
import type { McpToolContext, ToolResult } from "./tools.js";

const EXAMPLE_BODY = JSON.stringify({
  agent: "nodes/archivist",
  persona: { name: "Archivist", avatar: "🦉" },
  scope: { read: ["gtm", "ops"], propose: ["gtm"] },
  caps: { max_proposals: 5, max_comments: 5 },
  dry_run: true,
});

export const METACOGNITION_TOOL_DEFINITIONS = [
  {
    name: "metacognition_list",
    description:
      "List this nest's metacognition agents — agent documents the SERVER runs on its own, as a named persona, " +
      "whose only way to change the nest is a proposal a reviewer approves. Returns the configured agents (each with " +
      "its config and a plain-language summary of what it may do) and the agent documents not set up yet. " +
      "Call this first when the user asks about their metacognition agents or wants to set one up. Owner/admin only.",
    inputSchema: METACOGNITION_INPUT_SCHEMAS.list,
  },
  {
    name: "metacognition_configure",
    description:
      "Turn an agent document into a metacognition agent, or change one's settings. The document must be type agent, " +
      "and the server runs its APPROVED text as the agent's instructions (an unapproved agent document is skipped at run time). " +
      "ALWAYS call with dry_run: true first: it validates and returns the normalized config plus a plain-language summary " +
      "without saving. Show the user that summary, and save (dry_run omitted) only once they confirm. " +
      "Fields (the same body as PUT /nests/:id/metacognition/:node): persona {name, avatar: an emoji or up to 4 letters, never a URL}; " +
      "scope {read: folders it may read, [] = the whole nest; propose: folders it may suggest edits in, inside read — " +
      '[] = no edits, comments only; ["*"] = anywhere it reads}; caps {max_steps, max_tokens, max_seconds, max_proposals, max_comments} ' +
      "(clamped to server limits); feeds [{name, url: public https}]; mcp_servers [{name, url, allowed_tools: [...], auth_env?: MCP_*}]; " +
      "model (default: the nest's); enabled (default true). Unknown fields are ignored. The agent never publishes: every change it " +
      `makes goes to a reviewer. Owner/admin only. Example: ${EXAMPLE_BODY}`,
    inputSchema: METACOGNITION_INPUT_SCHEMAS.configure,
  },
  {
    name: "metacognition_run",
    description:
      "Start a metacognition agent now. The server runs it in the background and returns its run_id at once; follow it with " +
      "workflow_run_get { run_id }, and see its track record with workflow_runs_list { agent, agent_stats: true }. " +
      "Refused while the same agent is already running, and after too many starts in an hour. Owner/admin only.",
    inputSchema: METACOGNITION_INPUT_SCHEMAS.run,
  },
  {
    name: "metacognition_remove",
    description:
      "Stop a document being a metacognition agent. The agent document itself stays, as do its past runs and proposals. " +
      "Owner/admin only.",
    inputSchema: METACOGNITION_INPUT_SCHEMAS.remove,
  },
];

const NAMES = new Set(METACOGNITION_TOOL_DEFINITIONS.map((t) => t.name));
export const METACOGNITION_TOOL_NAMES: ReadonlySet<string> = NAMES;
export const isMetacognitionTool = (name: string): boolean => NAMES.has(name);

/** An operation's refusal → a tool error carrying its message unchanged.
 *  CONFLICT (409: already running, too many starts this hour) means "try
 *  again later", not "fix the input". */
function refusal(err: unknown): ToolResult {
  if (!(err instanceof AppError)) throw err;
  const code =
    err.statusCode === 403
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

export async function runMetacognitionTool(
  toolName: string,
  args: Record<string, any>,
  ctx: McpToolContext,
): Promise<ToolResult> {
  try {
    if (!metacognitionEnabled()) return refusal(new NotFoundError(NOT_ENABLED));
    await assertCanManageMetacognition(ctx.nestId, ctx.userId);
    switch (toolName) {
      case "metacognition_list": {
        const agents = (await listAgents(ctx.nestId)).map((a) => ({
          ...agentView(a),
          summary: summarizeConfig(a.config, { enabled: a.enabled }),
        }));
        const configured = new Set(agents.map((a) => a.node_id));
        const docs = await ctx.storage.discoverDocuments();
        const unconfigured = docs
          .filter((d) => (d.frontmatter.type || "document") === "agent" && !configured.has(d.id))
          .map((d) => ({
            node_id: d.id,
            title: d.frontmatter.title,
            summary: "Not a metacognition agent yet. Set it up with metacognition_configure (dry_run first).",
          }))
          .sort((a, b) => a.node_id.localeCompare(b.node_id));
        const lines = [
          agents.length ? "## Metacognition agents" : "No metacognition agents yet.",
          ...agents.map((a) => `- ${a.persona.name} (${a.node_id})${a.enabled ? "" : " — switched off"}: ${a.summary}`),
        ];
        if (unconfigured.length) {
          lines.push("", "## Agent documents not set up yet", ...unconfigured.map((d) => `- ${d.title} (${d.node_id})`));
        }
        return { text: lines.join("\n"), data: { agents, unconfigured } };
      }
      case "metacognition_configure": {
        const { agent: _agent, dry_run, nest: _nest, client: _client, confirm_billing: _cb, ...body } = args;
        // Fail closed: a dry_run of "true" or 1 must never read as "save it".
        if (dry_run !== undefined && typeof dry_run !== "boolean") {
          throw new ValidationError("dry_run must be true or false");
        }
        if (dry_run === true) {
          const v = await validateAgentConfig(ctx.nestId, agentArg(args), body);
          const summary = summarizeConfig(v.config, { enabled: v.enabled });
          return {
            text: `Dry run — nothing saved.\n\n${summary}\n\nShow the user this summary; call again without dry_run to save it.`,
            data: { dry_run: true, saved: false, node_id: v.nodeId, enabled: v.enabled, config: v.config, summary },
          };
        }
        const agent = await configureAgent({
          nestId: ctx.nestId,
          nodeId: agentArg(args),
          body,
          savedBy: await resolveCallerEmail(ctx.userId),
        });
        // Summarized from what was stored, so it describes the saved agent.
        const { persona, scope, caps, feeds, mcp_servers, model, enabled } = agent;
        const summary = summarizeConfig(
          { persona: { name: persona.name, avatar: persona.avatar }, scope, caps, feeds, mcp_servers, model },
          { enabled },
        );
        return {
          text: `Saved ${agent.node_id} as a metacognition agent.\n\n${summary}`,
          data: { dry_run: false, saved: true, agent, summary },
        };
      }
      case "metacognition_run": {
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
      case "metacognition_remove": {
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
    return refusal(err);
  }
}
