/**
 * Agent team stream S3 over MCP (PO-1181): `context_promote_thread`, the twin
 * of POST /nests/:id/threads/:threadId/promote. It calls the same
 * `promoteThread` service and returns that object as structuredContent, so
 * the two surfaces cannot drift (AC-ST-06).
 *
 * Write tier: not in MCP_READ_TOOLS, so a read-only key is refused before it
 * gets here; the service then checks node read, create rights and (on a
 * channel) posting rights for the caller, exactly as for REST.
 *
 * Not behind EXPERIMENTAL_AGENT_STREAM: a document comment thread can be
 * promoted too.
 *
 * Also `context_agent_webhooks`, the twin of /nests/:id/agent-webhooks
 * (list / set / delete wake-up targets; owner/admin only).
 *
 * Inline schema: promoting a thread is Community-only (the comment-thread
 * store is this edition's), so the engine has no operation to import a
 * descriptor from (scripts/check-mcp-schemas.mjs baseline raised to 102,
 * then 103 for context_agent_webhooks, documented there). Artifact cards ride on context_channel_read's existing
 * output instead of a tool of their own.
 */
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { promoteText, promoteThread } from "../stream/promote.js";
import {
  assertCanManageAgentWebhooks,
  deleteAgentWebhook,
  listAgentWebhooks,
  putAgentWebhook,
} from "../stream/agent-webhooks.js";
import { toolError, type McpToolContext, type ToolResult } from "./tools.js";

export const STREAM_TOOL_DEFINITIONS = [
  {
    name: "context_promote_thread",
    description:
      "Turn a settled comment thread — a channel post or a document comment thread — into a governed node: a decision " +
      '(kind "decision", a document tagged #decision under nodes/decisions/) or a task (kind "task", under nodes/tasks/). ' +
      "The node's body quotes the thread, its `source_thread` points back at it, and the thread gets a reply linking the node. " +
      "Needs write access to the nest (and posting rights in a channel). Get thread ids from context_channel_read or context_comments.",
    inputSchema: {
      type: "object" as const,
      properties: {
        thread: { type: "string", description: "The thread (post) id to promote." },
        kind: { type: "string", description: 'What to create: "decision" (default) or "task".' },
        title: { type: "string", description: "The new node's title. Default: the thread's first line." },
        folder: { type: "string", description: 'Folder under nodes/ to create it in. Default "decisions" or "tasks".' },
      },
      required: ["thread"],
    },
  },
  {
    name: "context_agent_webhooks",
    description:
      "Where an @mention of an agent in this nest is delivered (nest owner or admin only). " +
      'action "list" (default) shows each agent handle and its target as host#hash — never the URL or the secret; ' +
      '"set" saves a public https URL for a handle (private, loopback, link-local and metadata addresses are refused) and returns the signing secret ONCE, ' +
      'on the first save or with rotate: true; "delete" removes a handle\'s target. ' +
      "When a person's message @mentions the handle, the server POSTs one signed event (X-ContextNest-Signature, HMAC-SHA256) to the URL.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: 'One of "list" (default), "set", "delete".' },
        handle: { type: "string", description: 'The agent\'s @name, e.g. "grok" (set, delete).' },
        url: { type: "string", description: "Public https URL the event is POSTed to (set)." },
        rotate: { type: "boolean", description: "set: mint a new signing secret (returned once)." },
      },
    },
  },
];

const NAMES = new Set(STREAM_TOOL_DEFINITIONS.map((t) => t.name));

export function isStreamTool(name: string): boolean {
  return NAMES.has(name);
}

export async function runStreamTool(
  toolName: string,
  args: Record<string, any>,
  ctx: McpToolContext,
): Promise<ToolResult> {
  if (toolName === "context_agent_webhooks") return runAgentWebhooks(args, ctx);
  if (toolName !== "context_promote_thread") return toolError(`Unknown tool: ${toolName}`, "VALIDATION_FAILED");
  if (ctx.capability === "read") {
    return toolError("This API key is read-only and cannot promote a thread.", "UNAUTHORIZED_ACTION");
  }
  try {
    const data = await promoteThread(
      { nestId: ctx.nestId, userId: ctx.userId, userEmail: ctx.userEmail, client: ctx.client },
      { thread: args.thread, kind: args.kind, title: args.title, folder: args.folder },
    );
    return { text: promoteText(data), data };
  } catch (err) {
    if (err instanceof NotFoundError) return toolError(err.message, "DOCUMENT_NOT_FOUND");
    if (err instanceof ForbiddenError) return toolError(err.message, "UNAUTHORIZED_ACTION");
    if (err instanceof ConflictError) return toolError(err.message, "DOCUMENT_ALREADY_EXISTS");
    if (err instanceof ValidationError) return toolError(err.message, "VALIDATION_FAILED");
    if (err instanceof AppError && err.statusCode === 403) return toolError(err.message, "UNAUTHORIZED_ACTION");
    throw err;
  }
}

function refusal(err: unknown): ToolResult {
  if (err instanceof NotFoundError) return toolError(err.message, "DOCUMENT_NOT_FOUND");
  if (err instanceof ForbiddenError) return toolError(err.message, "UNAUTHORIZED_ACTION");
  if (err instanceof ConflictError) return toolError(err.message, "DOCUMENT_ALREADY_EXISTS");
  if (err instanceof ValidationError) return toolError(err.message, "VALIDATION_FAILED");
  if (err instanceof AppError && err.statusCode === 403) return toolError(err.message, "UNAUTHORIZED_ACTION");
  throw err;
}

/**
 * context_agent_webhooks — twin of /nests/:id/agent-webhooks (PO-1181
 * follow-up: MCP parity). Same gate (assertCanManageAgentWebhooks), same
 * service, same objects as REST: list = GET body, set = PUT body (secret only
 * when minted), delete = DELETE body. A read-only key never reaches it (not
 * in MCP_READ_TOOLS: even the list is an admin view of where events go).
 */
async function runAgentWebhooks(args: Record<string, any>, ctx: McpToolContext): Promise<ToolResult> {
  const action = String(args.action ?? "list").toLowerCase();
  try {
    if (ctx.capability === "read") {
      return toolError("This API key is read-only and cannot manage agent webhooks.", "UNAUTHORIZED_ACTION");
    }
    if (action === "list") {
      await assertCanManageAgentWebhooks(ctx.nestId, ctx.userId, { write: false });
      const data = { webhooks: await listAgentWebhooks(ctx.nestId) };
      const text = data.webhooks.length
        ? `# Agent webhooks (${data.webhooks.length})\n\n${data.webhooks.map((w) => `- @${w.handle} → ${w.target} (set by ${w.created_by}, ${w.updated_at})`).join("\n")}`
        : 'No agent webhooks. Add one with context_agent_webhooks { action: "set", handle, url }.';
      return { text, data };
    }
    if (action === "set") {
      await assertCanManageAgentWebhooks(ctx.nestId, ctx.userId, { write: true });
      const data = await putAgentWebhook(ctx.nestId, args.handle, { url: args.url, rotate: args.rotate }, ctx.userEmail);
      const text = data.secret
        ? `Saved @${data.webhook.handle} → ${data.webhook.target}. Signing secret (shown once — store it in the runner now): ${data.secret}`
        : `Saved @${data.webhook.handle} → ${data.webhook.target}. The signing secret is unchanged (pass rotate: true for a new one).`;
      return { text, data };
    }
    if (action === "delete") {
      await assertCanManageAgentWebhooks(ctx.nestId, ctx.userId, { write: true });
      await deleteAgentWebhook(ctx.nestId, args.handle);
      return { text: `Removed the webhook for @${String(args.handle ?? "").replace(/^@/, "")}.`, data: { deleted: true } };
    }
    return toolError(`Unknown action "${action}" — use list, set or delete.`, "VALIDATION_FAILED");
  } catch (err) {
    return refusal(err);
  }
}
