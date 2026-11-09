/**
 * Channels over MCP (PO-1179, agent team stream S1) — the REST twins of
 * /nests/:id/channels. Experimental: registered only while
 * EXPERIMENTAL_AGENT_STREAM is on (mcp/routes.ts), and re-checked here.
 *
 *   context_channels      list (default) | create | archive | unarchive
 *   context_channel_read  a channel's timeline, or one thread (paged)
 *
 * Posting is `context_comment` with the channel's node id — the same tool and
 * the same @mention fan-out as a document comment; a channel only adds that
 * the poster must be able to write in the nest.
 *
 * Each tool calls the same service function its REST route calls and returns
 * that function's object as structuredContent, so the two surfaces cannot
 * drift (AC-CH-07).
 *
 * Inline schemas: channels are Community-only (a node convention plus the
 * comment-thread store); the engine has no channel operation to import a
 * descriptor from (scripts/check-mcp-schemas.mjs baseline raised, documented).
 */
import { config } from "../config.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import {
  createChannel,
  listChannels,
  readChannel,
  setChannelArchived,
  timelineText,
  type ChannelView,
} from "../channels/channel-service.js";
import { toolError, type McpToolContext, type ToolResult } from "./tools.js";

export const CHANNEL_TOOL_DEFINITIONS = [
  {
    name: "context_channels",
    description:
      "Channels in this nest: Slack-style conversations where agents and people post, reply in threads and @tag each other, next to the knowledge. " +
      'action "list" (default) returns the channels; "create" makes one (name, optional purpose; needs write access); ' +
      '"archive" / "unarchive" hides or restores one (needs write access). Post with context_comment { id: "nodes/channels/<name>", body }; read with context_channel_read.',
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: 'One of "list" (default), "create", "archive", "unarchive".' },
        name: { type: "string", description: 'Channel name, e.g. "ops" (create, archive, unarchive).' },
        purpose: { type: "string", description: "What the channel is for (create). Stored as the channel node's body." },
        include_archived: { type: "boolean", description: "list: include archived channels." },
      },
    },
  },
  {
    name: "context_channel_read",
    description:
      "Read a channel: its top-level posts newest first, each with its reply count and thread id, paged with limit/offset. " +
      "Pass `thread` (a post's id) to read that post and its replies oldest first. Each message names who wrote it, as " +
      '"<agent>, on behalf of <person>" when an agent did, and carries `cards`: the nest artifacts it links ([[wikilinks]], document and hosted-artifact URLs), ' +
      "each with title, type, stage and version when you can read it, or marked unresolved when you can't.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string", description: 'Channel name, e.g. "ops" (from context_channels).' },
        thread: { type: "string", description: "A post's id, to read that thread instead of the timeline." },
        limit: { type: "number", description: "Posts per page (default 50, max 200)." },
        offset: { type: "number", description: "Posts to skip (default 0)." },
      },
      required: ["channel"],
    },
  },
];

const NAMES = new Set(CHANNEL_TOOL_DEFINITIONS.map((t) => t.name));

export function isChannelTool(name: string): boolean {
  return NAMES.has(name);
}

function refusal(err: unknown): ToolResult {
  if (err instanceof NotFoundError) return toolError(err.message, "DOCUMENT_NOT_FOUND");
  if (err instanceof ForbiddenError) return toolError(err.message, "UNAUTHORIZED_ACTION");
  if (err instanceof ConflictError) return toolError(err.message, "DOCUMENT_ALREADY_EXISTS");
  if (err instanceof ValidationError) return toolError(err.message, "VALIDATION_FAILED");
  if (err instanceof AppError && err.statusCode === 403) return toolError(err.message, "UNAUTHORIZED_ACTION");
  throw err;
}

function channelLine(c: ChannelView): string {
  const posts = `${c.post_count} post${c.post_count === 1 ? "" : "s"}`;
  return `- **${c.title}** (${c.id}) — ${posts}${c.archived ? ", archived" : ""}${c.purpose ? `: ${c.purpose.split("\n")[0]}` : ""}`;
}

export async function runChannelTool(
  toolName: string,
  args: Record<string, any>,
  ctx: McpToolContext,
): Promise<ToolResult> {
  if (!config.EXPERIMENTAL_AGENT_STREAM) {
    return toolError(
      "Channels are an experimental feature that is not enabled on this server (EXPERIMENTAL_AGENT_STREAM).",
      "DOCUMENT_NOT_FOUND",
    );
  }
  const caller = { nestId: ctx.nestId, userId: ctx.userId, userEmail: ctx.userEmail, crossNest: ctx.crossNest === true };
  try {
    if (toolName === "context_channel_read") {
      const t = await readChannel(caller, {
        channel: args.channel,
        thread: args.thread,
        limit: args.limit,
        offset: args.offset,
      });
      return { text: timelineText(t), data: t };
    }

    const action = String(args.action ?? "list").toLowerCase();
    if (action === "list") {
      const data = await listChannels(caller, { includeArchived: args.include_archived === true });
      const text = data.channels.length
        ? `# Channels (${data.channels.length})\n\n${data.channels.map(channelLine).join("\n")}`
        : 'No channels yet. Create one with context_channels { action: "create", name }.';
      return { text, data };
    }
    // Every other action writes — a read-only key never gets this far for a
    // write (runTool's capability gate), but say so plainly if it does.
    if (ctx.capability === "read") {
      return toolError("This API key is read-only and cannot create or archive channels.", "UNAUTHORIZED_ACTION");
    }
    if (action === "create") {
      const data = await createChannel({ ...caller, client: ctx.client }, { name: args.name, purpose: args.purpose });
      return {
        text: `Created ${data.channel.title} (${data.channel.id}). Post with context_comment { id: "${data.channel.id}", body }.`,
        data,
      };
    }
    if (action === "archive" || action === "unarchive") {
      const data = await setChannelArchived({ ...caller, client: ctx.client }, args.name, action === "archive");
      return { text: `${data.channel.title} is ${data.channel.archived ? "archived" : "active"}.`, data };
    }
    return toolError(`Unknown action "${action}" — use list, create, archive or unarchive.`, "VALIDATION_FAILED");
  } catch (err) {
    return refusal(err);
  }
}
