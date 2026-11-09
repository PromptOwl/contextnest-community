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
 * Inline schema: promoting a thread is Community-only (the comment-thread
 * store is this edition's), so the engine has no operation to import a
 * descriptor from (scripts/check-mcp-schemas.mjs baseline raised to 102,
 * documented there). Artifact cards ride on context_channel_read's existing
 * output instead of a tool of their own.
 */
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { promoteText, promoteThread } from "../stream/promote.js";
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
