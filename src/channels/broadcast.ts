/**
 * `@channel` and `@here` in a channel message (PO-1196, team chat C1).
 *
 * Parsed like any other mention (shared/mentions.ts extractMentions: the
 * names `channel` and `here`, outside code). In a CHANNEL, written by a
 * member — which is the only way a channel message gets written — either
 * puts the message in front of every other person added to the nest: one
 * My Work mention row each (the same rows a `@name` makes, so "answered",
 * "mark done" and access are decided exactly as for a named mention). In a
 * document comment thread they are plain text that names nobody.
 *
 * `@here` is meant to reach the members active right now. This branch has no
 * presence signal (that is slice C2), so it reaches the same people as
 * `@channel`; API.md says so, and C2 narrows it when presence exists.
 *
 * Bounded: a nest with more than BROADCAST_MAX_MEMBERS people is refused
 * BEFORE the message is written (channelPostRefusal), with a message that
 * says so — a broadcast is a fan-out, and 200 rows per message is where it
 * stops being one person's message and starts being a mailing list.
 *
 * Never a wake-up: an agent is woken by its own handle only (people only,
 * owner decision). Never an inbox or email notification either: the rows
 * are the queue, the channel's unread count is the signal.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { listNestPeople, type NestPerson } from "../nests/people-service.js";
import { extractMentions } from "../shared/mentions.js";
import { retryAfterSeconds, tryConsume, type RateLimitConfig } from "../shared/rate-limit.js";

/** `@channel` / `@here` per person: each is a fan-out. */
export const BROADCAST_LIMIT: RateLimitConfig = { max: 10, windowMs: 10 * 60_000 };

export const BROADCAST_NAMES = new Set(["channel", "here"]);

/** People ADDED to the nest: owner, collaborators, stewards, team members —
 *  not someone whose only way in is a share on one document. */
const isMemberSource = (p: NestPerson) => p.source !== "grant" && p.source !== "directory";
/** Most people one `@channel` may reach; past it the post is refused. */
export const BROADCAST_MAX_MEMBERS = 200;

/** The broadcast names a body carries, in order ("channel", "here"). */
export function broadcastNames(body: string): string[] {
  return extractMentions(body || "")
    .map((n) => n.toLowerCase())
    .filter((n) => BROADCAST_NAMES.has(n));
}

export function isBroadcastName(name: string): boolean {
  return BROADCAST_NAMES.has(String(name ?? "").trim().toLowerCase());
}

export interface BroadcastRefusal {
  status: 400 | 429;
  error: string;
  retryAfter?: number;
}

/**
 * Why a body with `@channel` / `@here` may not be posted in this nest by this
 * person, or null: the roster is too big to broadcast to (400), or they have
 * broadcast BROADCAST_LIMIT times lately (429; a token is spent on each
 * attempt that gets this far). Costs nothing for a body without a broadcast
 * name. Checked BEFORE the message is written, by post and by edit alike.
 */
export async function broadcastRefusal(nestId: string, body: string, userId: string): Promise<BroadcastRefusal | null> {
  if (broadcastNames(body).length === 0) return null;
  const people = (await listNestPeople(nestId)).filter((p) => p.userId && isMemberSource(p));
  if (people.length > BROADCAST_MAX_MEMBERS) {
    return {
      status: 400,
      error: `@channel and @here reach everyone added to the nest, and this nest has more than ${BROADCAST_MAX_MEMBERS} people. Name the people you mean instead.`,
    };
  }
  const key = `chat-broadcast:${userId}`;
  if (!tryConsume(key, BROADCAST_LIMIT)) {
    return {
      status: 429,
      error: "You have reached everyone with @channel or @here several times just now — wait a while, or name the people you mean.",
      retryAfter: retryAfterSeconds(key, BROADCAST_LIMIT),
    };
  }
  return null;
}

/**
 * Index a just-written channel message's `@channel` / `@here` as a mention
 * row for every other person added to the nest (skipping anyone the message
 * already names, so nobody gets two rows for one message). Returns how many
 * people it reached. Best-effort, like the named-mention index.
 */
export async function indexBroadcast(params: {
  nestId: string;
  nodeId: string;
  threadId: string;
  commentId: string;
  body: string;
  authorEmail: string;
}): Promise<number> {
  const { nestId, nodeId, threadId, commentId, body, authorEmail } = params;
  if (broadcastNames(body).length === 0) return 0;
  try {
    const author = authorEmail.toLowerCase();
    const db = getDb();
    // People the message already names have their row (mention-index.ts).
    const skip = new Set(
      ((await db.all("SELECT mentioned_user_id FROM comment_mentions WHERE comment_id = ? AND mentioned_user_id IS NOT NULL", [
        commentId,
      ])) as Array<{ mentioned_user_id: string }>).map((r) => r.mentioned_user_id),
    );
    const people = (await listNestPeople(nestId)).filter(
      (p) => p.userId && isMemberSource(p) && p.email.toLowerCase() !== author && !skip.has(p.userId),
    );
    if (people.length > BROADCAST_MAX_MEMBERS) return 0;
    const msg = (await db.get("SELECT created_at FROM annotation_comments WHERE id = ?", [commentId])) as
      | { created_at: string }
      | undefined;
    if (!msg) return 0;
    const seen = new Set<string>();
    let n = 0;
    for (const p of people) {
      if (seen.has(p.userId!)) continue;
      seen.add(p.userId!);
      await db.run(
        `INSERT INTO comment_mentions
           (id, nest_id, node_id, thread_id, comment_id, mentioned_user_id, handle, author, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), nestId, nodeId, threadId, commentId, p.userId, p.email.toLowerCase(), author, msg.created_at],
      );
      n++;
    }
    return n;
  } catch (err) {
    console.error("[mentions] broadcast index failed", nestId, nodeId, threadId, err);
    return 0;
  }
}

/** How many OTHER people a broadcast in this nest reaches (for the post-time
 *  outcome), without writing anything. */
export async function broadcastReach(nestId: string, authorEmail: string): Promise<number> {
  const author = authorEmail.toLowerCase();
  const ids = new Set<string>();
  for (const p of await listNestPeople(nestId)) if (p.userId && isMemberSource(p) && p.email.toLowerCase() !== author) ids.add(p.userId);
  return ids.size;
}
