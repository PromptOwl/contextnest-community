/**
 * Team chat harness C2 over MCP (PO-1197) — the REST twins of
 * /nests/:id/conversations, the channel membership routes, /me/chat and
 * /nests/:id/chat/presence. Offered only while TEAM_CHAT_ENABLED is on
 * (mcp/routes.ts) and re-checked here, with the nest's own chat setting.
 *
 *   context_conversations      list (default) | create | find | leave | add
 *   context_conversation_read  a conversation's timeline, one thread, or what is new since
 *   context_channel_members    list (default) | invite | join | leave | set_private
 *   context_chat_preferences   get (default) | set
 *   context_presence           list (default) | set
 *
 * Each calls the service function its REST route calls and returns that
 * object as structuredContent, so the two surfaces cannot drift. A read-only
 * key is offered the read actions only (CHAT_READ_KEY_TOOL_VIEWS) and every
 * writing action answers READ_ONLY_KEY_REFUSAL.
 *
 * No tool for the event stream: an MCP client polls — `context_channel_read`
 * / `context_conversation_read` with `since`, and `context_my_work` (whose
 * `chat` section is the unread summary) — which carries the same data; a
 * long-lived server-push stream has no place in a tool call.
 *
 * Inline schemas: conversations, membership, preferences and presence are
 * Community-only (this edition's tables and memory), so the engine has no
 * operation to import a descriptor from (scripts/check-mcp-schemas.mjs
 * baseline raised 103 → 108, documented there).
 */
import { config } from "../config.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { actingAgentHandle } from "../mentions/mention-index.js";
import {
  addConversationMember,
  conversationText,
  findOrCreateConversation,
  leaveConversation,
  listConversations,
  readConversation,
  type ConversationView,
} from "../chat/conversations.js";
import { inviteChannelMember, joinChannel, leaveChannel, listChannelMembers, setChannelPrivate } from "../chat/members.js";
import { getPreferences, setPreference } from "../chat/preferences.js";
import { activePresence, heartbeat, parseStatus, PRESENCE_TTL_MS } from "../chat/presence.js";
import { nestChatEnabled } from "../chat/settings.js";
import { READ_ONLY_KEY_REFUSAL } from "./channel-tools.js";
import { toolError, type McpToolContext, type ToolResult } from "./tools.js";

export const CHAT_TOOL_DEFINITIONS = [
  {
    name: "context_conversations",
    description:
      "Direct and group messages in this nest (team chat). " +
      'action "list" (default) returns the conversations you are in, each with `unread` and `last_activity_at`; ' +
      '"create" (or "find") starts a conversation with exactly these `members` — people by name or email, agents by @handle — or returns the one that already has that member set (`created` says which); ' +
      '"leave" leaves a group; "add" adds a `member` to a group. ' +
      "Read one with context_conversation_read { conversation }; post with context_comment { id: \"<conversation id>\", body } (add thread to reply).",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: 'One of "list" (default), "create", "find", "leave", "add".' },
        members: { type: "array", items: { type: "string" }, description: "create/find: the other members (you are always one). Names, emails or @handles." },
        conversation: { type: "string", description: "leave/add: the conversation id (nodes/conversations/<uuid>)." },
        member: { type: "string", description: "add: who to add — a name, an email or an @handle." },
      },
    },
  },
  {
    name: "context_conversation_read",
    description:
      "Read a direct or group conversation: its top-level posts, latest activity first, each with its reply count and thread id, paged with limit/offset. " +
      "Pass `thread` (a post's id) to read that post and its replies oldest first. Pass `since` (the `next_since` of your last read, or a timestamp) " +
      "to get only what was written after it, oldest first, with a new `next_since`. Messages carry `mentions` and `cards` as in a channel. " +
      "Only members of the conversation can read it; anyone else is told it does not exist.",
    inputSchema: {
      type: "object" as const,
      properties: {
        conversation: { type: "string", description: "The conversation id (nodes/conversations/<uuid>, or the uuid)." },
        thread: { type: "string", description: "A post's id, to read that thread instead of the timeline." },
        since: { type: "string", description: "Return only messages after this: a message id (next_since) or a timestamp." },
        limit: { type: "number", description: "Posts (or new messages) per page (default 50, max 200)." },
        offset: { type: "number", description: "Posts to skip (default 0)." },
      },
      required: ["conversation"],
    },
  },
  {
    name: "context_channel_members",
    description:
      "A channel's member list and membership (team chat). " +
      'action "list" (default) returns the members and whether the channel is private; ' +
      '"invite" adds a `member` (a person added to the nest, or an agent @handle) — for the nest\'s writers and the channel\'s members; ' +
      '"join" joins a public channel; "leave" leaves one; ' +
      '"set_private" with `private: true|false` makes it members-only or public again (nest owner/admin). ' +
      "A private channel does not exist for non-members. Create one with context_channels { action: \"create\", name, private: true }.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: 'One of "list" (default), "invite", "join", "leave", "set_private".' },
        channel: { type: "string", description: 'The channel: its name ("ops"), "#ops" or its node id.' },
        member: { type: "string", description: "invite: who — a name, an email or an @handle." },
        private: { type: "boolean", description: "set_private: true for members-only, false for public." },
      },
      required: ["channel"],
    },
  },
  {
    name: "context_chat_preferences",
    description:
      "Your chat notification preferences (team chat). " +
      'action "get" (default) lists them; "set" sets `level` — "all" (every message in the conversation drops an inbox row), ' +
      '"mentions" (the default: only a message that @names you), "none" (muted: no inbox row, mail or team message) — ' +
      "for a nest (`nest_id`, default this nest) or one `conversation` in it (a channel node id or a conversation id). " +
      "Muting never changes what is unread or what context_my_work lists.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: 'One of "get" (default), "set".' },
        nest_id: { type: "string", description: "set: the nest (default: this one)." },
        conversation: { type: "string", description: "set: a channel node id (nodes/channels/<name>) or a conversation id; leave out for the nest default." },
        level: { type: "string", description: 'set: "all", "mentions" or "none".' },
      },
    },
  },
  {
    name: "context_presence",
    description:
      "Who is around in this nest (team chat). " +
      'action "list" (default) returns the members active in the last 5 minutes, each with `status` and `last_seen` (to the minute), agents shown as the agent; ' +
      '"set" is a heartbeat: marks you (or the agent your `client.agent` declares) active for 5 minutes, with an optional short `status`. ' +
      "Send one every minute or two while working here, not more.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: 'One of "list" (default), "set".' },
        status: { type: "string", description: "set: a short line about what you are doing (at most 80 characters)." },
      },
    },
  },
];

/** How these tools are offered to a READ-ONLY key: the read action only. */
export const CHAT_READ_KEY_TOOL_VIEWS: Record<
  string,
  {
    description: string;
    schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
    annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  }
> = {
  context_conversations: {
    description: "List the direct and group conversations you are in (this key is read-only: it can read them with context_conversation_read, and cannot create, leave or add).",
    schema: { type: "object", properties: { action: { type: "string", description: '"list" (the only action for this key).' } } },
    annotations: { title: "List conversations", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  context_channel_members: {
    description: "List a channel's members and whether it is private (this key is read-only: it cannot invite, join, leave or change privacy).",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", description: '"list" (the only action for this key).' },
        channel: { type: "string", description: 'The channel: its name ("ops"), "#ops" or its node id.' },
      },
      required: ["channel"],
    },
    annotations: { title: "List channel members", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  context_chat_preferences: {
    description: "Read your chat notification preferences (this key is read-only: it cannot change them).",
    schema: { type: "object", properties: { action: { type: "string", description: '"get" (the only action for this key).' } } },
    annotations: { title: "Chat preferences", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  context_presence: {
    description: "Who is around in this nest: members active in the last 5 minutes (this key is read-only: it cannot send a heartbeat).",
    schema: { type: "object", properties: { action: { type: "string", description: '"list" (the only action for this key).' } } },
    annotations: { title: "Presence", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
};

/** The chat tools a read-only key may call (the read actions; the write
 *  actions are refused inside). */
export const CHAT_READ_TOOL_NAMES = ["context_conversations", "context_conversation_read", "context_channel_members", "context_chat_preferences", "context_presence"];

const NAMES = new Set(CHAT_TOOL_DEFINITIONS.map((t) => t.name));

export function isChatTool(name: string): boolean {
  return NAMES.has(name);
}

function refusal(err: unknown): ToolResult {
  if (err instanceof NotFoundError) return toolError(err.message, "DOCUMENT_NOT_FOUND");
  if (err instanceof ForbiddenError) return toolError(err.message, "UNAUTHORIZED_ACTION");
  if (err instanceof ConflictError) return toolError(err.message, "DOCUMENT_ALREADY_EXISTS");
  if (err instanceof ValidationError) return toolError(err.message, "VALIDATION_FAILED");
  if (err instanceof AppError && err.statusCode === 403) return toolError(err.message, "UNAUTHORIZED_ACTION");
  if (err instanceof AppError && err.statusCode === 404) return toolError(err.message, "DOCUMENT_NOT_FOUND");
  throw err;
}

const callerOf = (ctx: McpToolContext) => ({ nestId: ctx.nestId, userId: ctx.userId, userEmail: ctx.userEmail, crossNest: ctx.crossNest === true });

function conversationLine(c: ConversationView): string {
  const unread = c.unread ? `, ${c.unread} unread` : "";
  const last = c.last_activity_at ? `, last activity ${c.last_activity_at}` : "";
  return `- **${c.title}** (${c.kind}, ${c.id}) — ${c.post_count} post${c.post_count === 1 ? "" : "s"}${unread}${last}`;
}

const NOT_ON = "Team chat is not enabled here (TEAM_CHAT_ENABLED on the server, and the nest's chat setting).";

export async function runChatTool(toolName: string, args: Record<string, any>, ctx: McpToolContext): Promise<ToolResult> {
  if (!config.TEAM_CHAT_ENABLED || !(await nestChatEnabled(ctx.nestId))) return toolError(NOT_ON, "DOCUMENT_NOT_FOUND");
  const caller = callerOf(ctx);
  const readOnly = ctx.capability === "read";
  const action = String(args?.action ?? "").toLowerCase();
  try {
    if (toolName === "context_conversation_read") {
      const t = await readConversation(caller, { conversation: args.conversation, thread: args.thread, since: args.since, limit: args.limit, offset: args.offset });
      return { text: conversationText(t), data: t };
    }

    if (toolName === "context_conversations") {
      if (!action || action === "list") {
        const data = await listConversations(caller);
        const text = data.conversations.length
          ? `# Conversations (${data.conversations.length})\n\n${data.conversations.map(conversationLine).join("\n")}\n\nRead one with context_conversation_read { conversation: "<id>" }; post with context_comment { id: "<id>", body }.`
          : 'No conversations yet. Start one with context_conversations { action: "create", members: ["<name or @handle>"] }.';
        return { text, data };
      }
      if (readOnly) return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
      if (action === "create" || action === "find") {
        const data = await findOrCreateConversation(caller, args.members);
        const c = data.conversation;
        return {
          text: `${data.created ? "Started" : "Found"} the ${c.kind} with ${c.title} (${c.id}). Post with context_comment { id: "${c.id}", body }; read with context_conversation_read { conversation: "${c.id}" }.`,
          data,
        };
      }
      if (action === "leave") {
        const data = await leaveConversation(caller, args.conversation);
        return { text: `Left ${data.conversation}.`, data };
      }
      if (action === "add") {
        const data = await addConversationMember(caller, args.conversation, args.member);
        return { text: `${data.conversation.id} now has: ${data.conversation.members.map((m) => (m.kind === "person" ? m.name : `@${m.handle}`)).join(", ")}.`, data };
      }
      return toolError(`Unknown action "${action}" — use list, create, find, leave or add.`, "VALIDATION_FAILED");
    }

    if (toolName === "context_channel_members") {
      if (!action || action === "list") {
        const data = await listChannelMembers(caller, args.channel);
        const lines = data.members.map((m) => (m.kind === "person" ? `- ${m.name} (${m.email})` : `- @${m.handle} (agent)`));
        return { text: `# Members of ${data.channel}${data.private ? " (private)" : ""}\n\n${lines.join("\n") || "Nobody has joined yet."}`, data };
      }
      if (readOnly) return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
      if (action === "invite") {
        const data = await inviteChannelMember(caller, args.channel, args.member);
        return { text: `${data.channel} now has ${data.members.length} member${data.members.length === 1 ? "" : "s"}.`, data };
      }
      if (action === "join") {
        const data = await joinChannel(caller, args.channel);
        return { text: `Joined ${data.channel.title}.`, data };
      }
      if (action === "leave") {
        const data = await leaveChannel(caller, args.channel);
        return { text: `Left ${data.channel}.`, data };
      }
      if (action === "set_private") {
        const data = await setChannelPrivate(caller, args.channel, args.private);
        return { text: `${data.channel.title} is now ${data.channel.private ? "private (members only)" : "public"}.`, data };
      }
      return toolError(`Unknown action "${action}" — use list, invite, join, leave or set_private.`, "VALIDATION_FAILED");
    }

    if (toolName === "context_chat_preferences") {
      if (!action || action === "get") {
        const data = await getPreferences(ctx.userId, { onlyNestId: ctx.crossNest === true ? null : ctx.nestId });
        const lines = data.nests.map(
          (n) => `- nest ${n.nest_id}: ${n.level}${n.conversations.length ? ` (${n.conversations.map((c) => `${c.conversation}: ${c.level}`).join(", ")})` : ""}`,
        );
        return { text: `# Chat preferences (default: ${data.default})\n\n${lines.join("\n") || "Nothing set: every nest at the default."}`, data };
      }
      if (readOnly) return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
      if (action === "set") {
        const nestId = typeof args.nest_id === "string" && args.nest_id.trim() ? args.nest_id.trim() : ctx.nestId;
        // A nest-scoped key stays in its nest.
        if (ctx.crossNest !== true && nestId !== ctx.nestId) return toolError("This key is scoped to one nest; it can set preferences there only.", "UNAUTHORIZED_ACTION");
        const data = await setPreference({ userId: ctx.userId, userEmail: ctx.userEmail }, { nest_id: nestId, conversation: args.conversation, level: args.level });
        const p = data.preference;
        return { text: `Set ${p.conversation ?? "the nest default"} to "${p.level}".`, data };
      }
      return toolError(`Unknown action "${action}" — use get or set.`, "VALIDATION_FAILED");
    }

    if (toolName === "context_presence") {
      if (!action || action === "list") {
        const data = { active: await activePresence(ctx.nestId), expires_in: PRESENCE_TTL_MS / 1000 };
        const lines = data.active.map((p) => `- ${p.label}${p.status ? ` — ${p.status}` : ""} (seen ${p.last_seen})`);
        return { text: `# Around now (${data.active.length})\n\n${lines.join("\n") || "Nobody in the last 5 minutes."}`, data };
      }
      if (readOnly) return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
      if (action === "set") {
        const status = parseStatus(args.status);
        const ok = heartbeat(ctx.nestId, { userId: ctx.userId, email: ctx.userEmail, agent: actingAgentHandle(ctx.client) ? ctx.client?.agent : null }, status);
        if (!ok) return toolError("Too many heartbeats — one every minute or two is plenty.", "VALIDATION_FAILED");
        return { text: `You are shown as active here for the next 5 minutes${status ? ` (${status})` : ""}.`, data: { ok: true, expires_in: PRESENCE_TTL_MS / 1000 } };
      }
      return toolError(`Unknown action "${action}" — use list or set.`, "VALIDATION_FAILED");
    }

    return toolError(`Unknown tool: ${toolName}`, "VALIDATION_FAILED");
  } catch (err) {
    return refusal(err);
  }
}
