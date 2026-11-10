/**
 * Finding ONE channel message and deciding what the caller may do to it —
 * the leaf every message action (reactions.ts, message-edits.ts, pins.ts,
 * saved.ts) and the permalink lookup share (PO-1196, team chat C1).
 *
 * A message is addressed by its id (annotation_comments.id) or, for a post,
 * by its thread id — the timeline hands out the thread id as the post's `id`,
 * so an agent that pastes it still lands on the opening message.
 *
 * WHO MAY (owner decision 2026-11-09): reading a message's state and acting
 * on it — react, pin, save, edit or delete one's own — is for people added
 * to the nest, a read-only collaborator included; the same `channelAccess`
 * rule as posting (archived channel or nest → 409 / 403). Someone who
 * reaches the nest only through its visibility or through a share on a
 * document — even a share on the channel node itself — gets NotFound, the
 * same answer as an unknown id (no existence oracle). A read-only API key is
 * stopped earlier by the capability gate.
 *
 * Rate limits live here too: in-memory, per person, the same limiter the
 * auth routes use. A refusal carries Retry-After.
 */
import type { ContextNode } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError } from "../shared/errors.js";
import { retryAfterSeconds, tryConsume, type RateLimitConfig } from "../shared/rate-limit.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { resolveUserRoles } from "../governance/stewardship-service.js";
import { config } from "../config.js";
import { channelNameOf } from "./channel-node.js";
import {
  MESSAGE_COLUMNS,
  channelAccess,
  getReadableChannel,
  isNestMember,
  messagesFromRows,
  type Caller,
  type ChannelNewMessage,
  type ChannelView,
  type CommentRow,
} from "./channel-service.js";
import { deserializeClient } from "../shared/client-metadata.js";
import { normHandle } from "./message-meta.js";

const NOT_FOUND = "Message not found";

export class RateLimitedError extends AppError {
  constructor(
    message: string,
    public retryAfterSeconds: number,
  ) {
    super(429, message);
    this.name = "RateLimitedError";
  }
}

/** One token for `key`, or a 429 with how long to wait. */
export function takeOrRefuse(key: string, cfg: RateLimitConfig, what: string): void {
  if (tryConsume(key, cfg)) return;
  throw new RateLimitedError(`Too many ${what} — wait a moment and try again.`, retryAfterSeconds(key, cfg));
}

/** The limiter first, after only the membership check (one cached access
 *  read), so a refused caller never pays for the message lookup. A
 *  non-member is NotFound before any token is spent. */
export async function memberOrRefuse(caller: Caller, key: string, cfg: RateLimitConfig, what: string): Promise<void> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError(NOT_FOUND);
  takeOrRefuse(key, cfg, what);
}

export const REACTION_LIMIT: RateLimitConfig = { max: 60, windowMs: 60_000 };
export const EDIT_LIMIT: RateLimitConfig = { max: 30, windowMs: 60_000 };
export const SEARCH_LIMIT: RateLimitConfig = { max: 60, windowMs: 60_000 };
/** Pin, unpin, save, unsave: cheap rows, so a generous limit on churn. */
export const MARK_LIMIT: RateLimitConfig = { max: 120, windowMs: 60_000 };


export type ActingCaller = Caller & { client?: ClientMetadata };

export interface LocatedMessage {
  node: ContextNode;
  view: ChannelView;
  row: CommentRow;
  /** False for the message that opened its thread. */
  reply: boolean;
}

type RowWithNode = CommentRow & { node_id: string };

async function rowById(nestId: string, id: string, nodeId: string | null): Promise<RowWithNode | undefined> {
  const db = getDb();
  const scope = nodeId ? " AND t.node_id = ?" : "";
  const args = nodeId ? [nestId, nodeId] : [nestId];
  const direct = (await db.get(
    `SELECT ${MESSAGE_COLUMNS}, t.node_id FROM annotation_comments c
       JOIN annotation_threads t ON t.id = c.thread_id
      WHERE c.id = ? AND t.nest_id = ?${scope}`,
    [id, ...args],
  )) as RowWithNode | undefined;
  if (direct) return direct;
  // A thread id: its opening message.
  return (await db.get(
    `SELECT ${MESSAGE_COLUMNS}, t.node_id FROM annotation_comments c
       JOIN annotation_threads t ON t.id = c.thread_id
      WHERE t.id = ? AND t.nest_id = ?${scope}
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT 1`,
    [id, ...args],
  )) as RowWithNode | undefined;
}

/**
 * The message, if it is in a channel of this nest the caller — a person
 * added to the nest — can read; NotFound otherwise, for every reason alike.
 * `channel` scopes the lookup to one channel (the /channels/:name routes);
 * null finds the channel from the message (the permalink lookup).
 */
export async function locateMessage(caller: Caller, channel: unknown | null, rawId: unknown): Promise<LocatedMessage> {
  const id = typeof rawId === "string" ? rawId.trim() : "";
  if (!id || id.length > 100) throw new NotFoundError(NOT_FOUND);
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError(NOT_FOUND);
  let readable: { node: ContextNode; view: ChannelView } | undefined;
  let row: RowWithNode | undefined;
  if (channel !== null && channel !== undefined && channel !== "") {
    try {
      readable = await getReadableChannel(caller, channel);
    } catch {
      throw new NotFoundError(NOT_FOUND);
    }
    row = await rowById(caller.nestId, id, readable.node.id);
  } else {
    row = await rowById(caller.nestId, id, null);
    const name = row ? channelNameOf(row.node_id) : null;
    if (!name) throw new NotFoundError(NOT_FOUND);
    try {
      readable = await getReadableChannel(caller, name);
    } catch {
      throw new NotFoundError(NOT_FOUND);
    }
  }
  if (!row || !readable) throw new NotFoundError(NOT_FOUND);
  const first = (await getDb().get(
    "SELECT id FROM annotation_comments WHERE thread_id = ? ORDER BY created_at ASC, id ASC LIMIT 1",
    [row.thread_id],
  )) as { id: string } | undefined;
  const { node_id: _node, ...rest } = row;
  return { node: readable.node, view: readable.view, row: rest, reply: first?.id !== row.id };
}

/** The located message as a read returns it (with its extras). */
export async function viewOf(caller: Caller, located: LocatedMessage): Promise<ChannelNewMessage> {
  const [m] = await messagesFromRows(caller, located.view.name, [located.row]);
  return { ...m, reply: located.reply };
}

/** Acting on a message follows the posting rule of its channel. */
export async function assertMayAct(caller: Caller, located: LocatedMessage): Promise<void> {
  const access = await channelAccess(caller, located.node);
  if (access.post) {
    if (access.post.status === 409) throw new ConflictError(access.post.error);
    throw new ForbiddenError(access.post.error);
  }
}

export function assertNotDeleted(located: LocatedMessage): void {
  if (located.row.deleted_at) throw new ConflictError("This message was deleted.");
}

/** The agent handle the caller acts as, from a DECLARED agent only (a key
 *  label alone is not an agent: message-meta.ts messageClient). */
export function actingAs(client: ClientMetadata | undefined): string | null {
  const h = normHandle(client?.agent);
  return h || null;
}

/**
 * Author only: the same login, and — when the caller acts as an agent — a
 * message written as that agent. A person acting as nobody may edit what
 * their agents wrote under their login; an agent may not touch what the
 * person, or another agent, wrote.
 */
export function isAuthor(caller: ActingCaller, row: CommentRow): boolean {
  if (row.author.toLowerCase() !== caller.userEmail.toLowerCase()) return false;
  const agent = actingAs(caller.client);
  if (!agent) return true;
  // The message's DECLARED agent only (never its key label: a bare label is
  // not an agent on either side).
  return normHandle(deserializeClient(row.client_json)?.agent) === agent;
}

/** A nest owner or admin: may delete anyone's message (moderation). */
export async function isModerator(caller: Caller): Promise<boolean> {
  if (config.AUTH_MODE === "open") return true;
  const roles = await resolveUserRoles(caller.nestId, caller.userEmail);
  return roles.includes("owner") || roles.includes("admin");
}
