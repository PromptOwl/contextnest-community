/**
 * The nest in the conversation over MCP (team chat C7, PO-1198) — the twins
 * of src/agents/routes.ts. Registered only while EXPERIMENTAL_AGENT_STREAM is
 * on (mcp/routes.ts) and re-checked here.
 *
 *   context_ask_nest  ask the nest from a channel or thread, as the caller;
 *                     post: true posts the answer (and any proposal cards)
 *                     into the thread as Hootie, for the caller.
 *   context_agents    the agents this nest knows (list), one agent's profile
 *                     (handle), or set its description (owner/admin).
 *   context_handoff   hand a thread to a person or an agent (create), or
 *                     accept / done one.
 *
 * Proposals are decided with the existing `context_approve` / `context_reject`
 * (the review queue lists them under requested_by "hootie"); no tool here.
 * Each tool returns the service's object as structuredContent, so REST and
 * MCP cannot drift. A read-only key may call `context_agents` (a read) and
 * nothing else here (`context_ask_nest` spends model credits).
 *
 * Inline schemas: Community-only features over the comment-thread store
 * (scripts/check-mcp-schemas.mjs baseline raised to 106, documented there).
 */
import { config } from "../config.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { askNest, askText, NoModelKeyError } from "../agents/ask-nest.js";
import { agentsText, agentText, getAgent, listAgents, setAgentDescription } from "../agents/profiles.js";
import { createHandoff, handoffText, updateHandoff } from "../agents/handoffs.js";
import { mentionsLine } from "../channels/post-message.js";
import { messageClient } from "../channels/message-meta.js";
import { READ_ONLY_KEY_REFUSAL } from "./channel-tools.js";
import { toolError, type McpToolContext, type ToolResult } from "./tools.js";

export const AGENT_TOOL_DEFINITIONS = [
  {
    name: "context_ask_nest",
    description:
      "Ask the nest a question from inside a conversation — Hootie answers AS YOU, from what you can read, with the thread's messages as context and citations to documents. " +
      "Pass `thread` (a post id from context_channel_read) or `channel` (a name). Returns the answer, the documents it cites and any writes it proposed (nothing is written). " +
      "With post: true the answer is posted into the thread as a message from Hootie, for you, and each proposal becomes a draft in the review queue with a card in the thread, for a writer to approve with context_approve or reject with context_reject. " +
      "Rate-limited per person; needs HOOTIE_ENABLED and a model key on the server.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "What to ask (at most 4,000 characters)." },
        thread: { type: "string", description: "The thread (post id) to answer in." },
        channel: { type: "string", description: 'Or the channel name ("ops") — with post: true the answer opens a new post there.' },
        post: { type: "boolean", description: "Post the answer and proposal cards into the thread (default false)." },
      },
      required: ["question"],
    },
  },
  {
    name: "context_agents",
    description:
      "The agents this nest knows — Hootie, every handle with a wake-up webhook, and every declared agent that has posted in a channel — with what each is (kind hootie | webhook | key, owner, description), " +
      "when it was last seen and whether a mention wakes it. Pass `handle` for one agent's profile: its last messages, the proposals it filed, the nodes it authored or proposed (only what you can read). " +
      "A nest owner or admin passes `handle` and `description` to describe an agent (at most 500 characters; empty clears). Members only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        handle: { type: "string", description: 'An agent\'s @name, e.g. "grok" or "hootie" (profile, or set its description).' },
        description: { type: "string", description: "Set the agent's description (owner/admin). Empty string clears it." },
      },
    },
  },
  {
    name: "context_handoff",
    description:
      "Hand a channel thread to a person or an agent, recorded in the thread. action \"create\" (default) with `thread`, `to` (a person's name or email on this nest, or an agent handle) and an optional `note` posts a handoff message by you that @mentions the target, " +
      "so it lands in their My Work or wakes the agent; it carries handoff.status \"open\". action \"accept\" or \"done\" with `message_id` (the handoff's id) posts an update by you and moves the status. Members only; note at most 1,000 characters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: 'One of "create" (default), "accept", "done".' },
        thread: { type: "string", description: "The thread (post id) to hand off (create)." },
        to: { type: "string", description: "Who takes it: a person's name or email on this nest, or an agent handle (create)." },
        note: { type: "string", description: "What to do, or what was done (optional, at most 1,000 characters)." },
        message_id: { type: "string", description: "The handoff message's id (accept, done)." },
      },
    },
  },
];

const NAMES = new Set(AGENT_TOOL_DEFINITIONS.map((t) => t.name));

export function isAgentTool(name: string): boolean {
  return NAMES.has(name);
}

function refusal(err: unknown): ToolResult {
  if (err instanceof NoModelKeyError) return toolError(err.message, "UNAUTHORIZED_ACTION");
  if (err instanceof NotFoundError) return toolError(err.message, "DOCUMENT_NOT_FOUND");
  if (err instanceof ForbiddenError) return toolError(err.message, "UNAUTHORIZED_ACTION");
  if (err instanceof ConflictError) return toolError(err.message, "DOCUMENT_ALREADY_EXISTS");
  if (err instanceof ValidationError) return toolError(err.message, "VALIDATION_FAILED");
  if (err instanceof AppError && (err.statusCode === 403 || err.statusCode === 429)) return toolError(err.message, "UNAUTHORIZED_ACTION");
  throw err;
}

export async function runAgentTool(toolName: string, args: Record<string, any>, ctx: McpToolContext): Promise<ToolResult> {
  if (!config.EXPERIMENTAL_AGENT_STREAM) {
    return toolError("Channels are an experimental feature that is not enabled on this server (EXPERIMENTAL_AGENT_STREAM).", "DOCUMENT_NOT_FOUND");
  }
  const caller = { nestId: ctx.nestId, userId: ctx.userId, userEmail: ctx.userEmail, baseUrl: ctx.baseUrl ?? "" };
  try {
    if (toolName === "context_ask_nest") {
      if (ctx.capability === "read") return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
      const data = await askNest(caller, { channel: args.channel, thread: args.thread, question: args.question, post: args.post === true });
      return { text: askText(data), data };
    }
    if (toolName === "context_agents") {
      if (args.description !== undefined && args.handle) {
        if (ctx.capability === "read") return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
        const data = await setAgentDescription(caller, args.handle, args.description);
        return { text: `@${data.agent.handle}: ${data.agent.description ?? "(description cleared)"}`, data };
      }
      if (args.handle) {
        const data = await getAgent(caller, args.handle);
        return { text: agentText(data.agent), data };
      }
      const data = await listAgents(caller);
      return { text: agentsText(data.agents), data };
    }
    if (toolName === "context_handoff") {
      if (ctx.capability === "read") return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
      const action = String(args.action ?? "create").toLowerCase();
      const who = { ...caller, client: messageClient(ctx.client, args.client, ctx.apiKeyLabel) };
      if (action === "create") {
        const data = await createHandoff(who, args.thread, { to: args.to, note: args.note });
        const reached = mentionsLine(data.mentions);
        return { text: `${handoffText(data.handoff)}${reached ? `\n${reached}` : ""}`, data };
      }
      if (action === "accept" || action === "done") {
        const data = await updateHandoff(who, args.message_id, action === "accept" ? "accepted" : "done", args.note);
        return { text: handoffText(data.handoff), data };
      }
      return toolError(`Unknown action "${action}" — use create, accept or done.`, "VALIDATION_FAILED");
    }
    return toolError(`Unknown tool: ${toolName}`, "VALIDATION_FAILED");
  } catch (err) {
    return refusal(err);
  }
}
