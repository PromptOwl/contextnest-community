/**
 * Message search over channels (PO-1196, team chat C1): one nest
 * (`GET /nests/:id/channels/search`, and `messages` on the existing
 * `GET /nests/:id/search` / `context_search`) or every nest the caller is a
 * member of (`GET /me/chat/search`, and `messages` on `GET /search`); MCP
 * `context_channel_search`.
 *
 * ONE search engine: the matcher the document search already runs
 * (src/nodes/search.ts — `matchDocuments`, every whitespace-separated term
 * must occur, case- and accent-insensitive; `toSearchHit` for the snippet).
 * A message is matched as a document with no title (`id`, empty title, body),
 * so the same query finds the same text in a document and in a channel.
 *
 * Its bound: this server keeps no full-text index of messages (nor of
 * documents — those are matched in memory from the discovery cache), so the
 * database hands the matcher the SEARCH_SCAN_CEILING newest channel messages
 * in scope (after the exact filters: channel, author, before/after; never a
 * tombstone), and older ones are reached with `before=`. The ceiling is
 * returned on every response (`ceiling`) so a client can say so.
 *
 * Members only: non-members get NotFound, the same as any channel read. The
 * `from` filter takes a login (an email) or "me"; a display name is not a
 * search key, so a non-member can never use this to test who is on a nest.
 */
import type { ContextNode } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { fold, matchDocuments, toSearchHit } from "../nodes/search.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
import { channelNameOf, isChannelNode } from "./channel-node.js";
import {
  MESSAGE_COLUMNS,
  channelIdFor,
  isNestMember,
  messagesFromRows,
  parseChannelName,
  type Caller,
  type ChannelNewMessage,
  type CommentRow,
} from "./channel-service.js";
import { SEARCH_LIMIT, takeOrRefuse } from "./message-access.js";

/** Most messages (newest first, after the exact filters) one search matches. */
export const SEARCH_SCAN_CEILING = 5000;
export const SEARCH_PAGE_DEFAULT = 20;
export const SEARCH_PAGE_MAX = 50;
const MAX_SEARCH_OFFSET = SEARCH_SCAN_CEILING;
const MAX_QUERY_LENGTH = 200;

export interface SearchHit extends ChannelNewMessage {
  nest_id: string;
  nest_name: string;
  channel: string;
  message_id: string;
  /** A window of the body around the first match (toSearchHit's snippet). */
  excerpt: string;
  /** Where the terms occur IN THE EXCERPT (character offsets, end exclusive). */
  highlights: Array<{ start: number; end: number }>;
}

export interface SearchResult {
  results: SearchHit[];
  pagination: { limit: number; offset: number; has_more: boolean };
  /** Most messages one search considers (the newest in scope). */
  ceiling: number;
}

export interface SearchInput {
  q: unknown;
  channel?: unknown;
  from?: unknown;
  before?: unknown;
  after?: unknown;
  limit?: unknown;
  offset?: unknown;
}

export function parseQuery(raw: unknown): string {
  if (typeof raw !== "string") throw new ValidationError("q is required — what to search for (at least 2 characters).");
  const q = raw.trim();
  if (q.length < 2) throw new ValidationError("q is at least 2 characters.");
  if (q.length > MAX_QUERY_LENGTH) throw new ValidationError(`q is at most ${MAX_QUERY_LENGTH} characters.`);
  return q;
}

/** "2026-11-09T13:41:44.927Z" → "2026-11-09 13:41:44.927", the stored form. */
function toStored(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/** A `before` / `after` value → a stored timestamp to compare created_at
 *  with. A message id counts only when it is a channel message the caller
 *  can read (not a tombstone), so the bound is no oracle for other threads. */
async function timeBound(who: { userId: string; userEmail: string }, nestIds: string[], raw: unknown, name: string): Promise<string | null> {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = String(raw).trim();
  const refuse = () => new ValidationError(`${name} is a timestamp, or a message id from these channels.`);
  if (/^\d{4}-\d\d-\d\d([T ]\d\d:\d\d(:\d\d(\.\d+)?)?)?(Z|[+-]\d\d:?\d\d)?$/.test(value)) {
    const iso = value.replace(" ", "T");
    const zoned = /(Z|[+-]\d\d:?\d\d)$/.test(iso);
    const ms = Date.parse(zoned ? iso : `${iso}${iso.includes("T") ? "" : "T00:00:00"}Z`);
    if (Number.isNaN(ms)) throw refuse();
    return toStored(new Date(ms));
  }
  if (value.length > 100) throw refuse();
  const row = (await getDb().get(
    `SELECT c.created_at, t.nest_id, t.node_id FROM annotation_comments c JOIN annotation_threads t ON t.id = c.thread_id
      WHERE c.id = ? AND t.nest_id IN (${nestIds.map(() => "?").join(", ")})
        AND t.node_id LIKE 'nodes/channels/%' AND c.deleted_at IS NULL`,
    [value, ...nestIds],
  )) as { created_at: string; nest_id: string; node_id: string } | undefined;
  if (!row || !(await canOpenNode(row.nest_id, row.node_id, who.userId, who.userEmail).catch(() => false))) throw refuse();
  return row.created_at;
}

function parsePage(input: SearchInput): { limit: number; offset: number } {
  const l = Number(input.limit);
  const o = Number(input.offset);
  return {
    limit: Number.isFinite(l) && l >= 1 ? Math.min(Math.floor(l), SEARCH_PAGE_MAX) : SEARCH_PAGE_DEFAULT,
    offset: Number.isFinite(o) && o >= 0 ? Math.min(Math.floor(o), MAX_SEARCH_OFFSET) : 0,
  };
}

/**
 * Where the query's terms sit in a snippet (character offsets, end exclusive).
 * Compared accent-folded only when folding keeps the length (no combining
 * marks in the snippet); otherwise case-insensitively, so offsets always map
 * onto the snippet as returned.
 */
export function highlightsIn(snippet: string, query: string): Array<{ start: number; end: number }> {
  const folded = fold(snippet);
  const hay = folded.length === snippet.length ? folded : snippet.toLowerCase();
  const out: Array<{ start: number; end: number }> = [];
  for (const term of new Set((hay === folded ? fold(query) : query.toLowerCase()).split(/\s+/).filter(Boolean))) {
    let i = hay.indexOf(term);
    while (i >= 0) {
      out.push({ start: i, end: i + term.length });
      i = hay.indexOf(term, i + term.length);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

type HitRow = CommentRow & { nest_id: string; node_id: string };

/** A message row as the document matcher sees it: a document with no title. */
function asDocument(r: HitRow): ContextNode {
  return { id: r.id, frontmatter: { title: "", type: "message", tags: [] }, body: r.body } as unknown as ContextNode;
}

/**
 * Search the given nests' channels for the caller. Each nest id is one the
 * caller is a MEMBER of (the callers below check); channels are filtered to
 * the ones they can read.
 */
async function search(
  who: { userId: string; userEmail: string },
  nestNames: Map<string, string>,
  input: SearchInput,
): Promise<SearchResult> {
  const q = parseQuery(input.q);
  const { limit, offset } = parsePage(input);
  const nestIds = [...nestNames.keys()];
  if (nestIds.length === 0) return { results: [], pagination: { limit, offset, has_more: false }, ceiling: SEARCH_SCAN_CEILING };
  takeOrRefuse(`chat-search:${who.userId}`, SEARCH_LIMIT, "searches");

  // The exact filters run in the database; the text match is the document
  // matcher's, over the newest SEARCH_SCAN_CEILING rows in scope.
  const where: string[] = [`t.nest_id IN (${nestIds.map(() => "?").join(", ")})`, "t.node_id LIKE 'nodes/channels/%'", "c.deleted_at IS NULL"];
  const params: unknown[] = [...nestIds];
  if (input.channel !== undefined && input.channel !== null && input.channel !== "") {
    let name: string;
    try {
      name = parseChannelName(input.channel);
    } catch {
      throw new ValidationError("channel is a channel name, e.g. \"ops\".");
    }
    where.push("t.node_id = ?");
    params.push(channelIdFor(name));
  }
  if (input.from !== undefined && input.from !== null && input.from !== "") {
    const from = String(input.from).trim().toLowerCase();
    if (from.length > 320) throw new ValidationError("from is a login (an email) or \"me\".");
    where.push("LOWER(c.author) = ?");
    params.push(from === "me" ? who.userEmail.toLowerCase() : from);
  }
  const before = await timeBound(who, nestIds, input.before, "before");
  const after = await timeBound(who, nestIds, input.after, "after");
  if (before) {
    where.push("c.created_at < ?");
    params.push(before);
  }
  if (after) {
    where.push("c.created_at > ?");
    params.push(after);
  }
  const rows = (await getDb().all(
    `SELECT ${MESSAGE_COLUMNS}, t.nest_id, t.node_id
       FROM annotation_comments c
       JOIN annotation_threads t ON t.id = c.thread_id
      WHERE ${where.join(" AND ")}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${SEARCH_SCAN_CEILING}`,
    params as any,
  )) as HitRow[];
  // Same matcher as the document search; a message has no title to rank by,
  // so the newest-first order is kept (Array#sort is stable).
  const byId = new Map(rows.map((r) => [r.id, r]));
  const matched = matchDocuments(rows.map(asDocument), q).map((d) => byId.get(d.id)!);

  // Which of the matched channels this caller can read, once per channel.
  const readable = new Map<string, boolean>();
  for (const r of matched) {
    const k = `${r.nest_id}\u0000${r.node_id}`;
    if (readable.has(k)) continue;
    readable.set(
      k,
      !!channelNameOf(r.node_id) &&
        (await isChannelNode(r.nest_id, r.node_id).catch(() => false)) &&
        (await canOpenNode(r.nest_id, r.node_id, who.userId, who.userEmail).catch(() => false)),
    );
  }
  const shown = matched.filter((r) => readable.get(`${r.nest_id}\u0000${r.node_id}`));
  const page = shown.slice(offset, offset + limit);

  const byChannel = new Map<string, HitRow[]>();
  for (const r of page) {
    const k = `${r.nest_id}\u0000${r.node_id}`;
    byChannel.set(k, [...(byChannel.get(k) ?? []), r]);
  }
  const built = new Map<string, ChannelNewMessage>();
  for (const [k, group] of byChannel) {
    const [nestId, nodeId] = k.split("\u0000");
    const caller: Caller = { nestId, userId: who.userId, userEmail: who.userEmail, crossNest: false };
    const messages = await messagesFromRows(caller, channelNameOf(nodeId)!, group);
    group.forEach((r, i) => built.set(r.id, messages[i]));
  }
  return {
    results: page.map((r) => {
      const excerpt = toSearchHit(asDocument(r), q).snippet;
      return {
        ...built.get(r.id)!,
        nest_id: r.nest_id,
        nest_name: nestNames.get(r.nest_id) ?? r.nest_id,
        channel: channelNameOf(r.node_id)!,
        message_id: r.id,
        excerpt,
        highlights: highlightsIn(excerpt, q),
      };
    }),
    pagination: { limit, offset, has_more: offset + page.length < shown.length },
    ceiling: SEARCH_SCAN_CEILING,
  };
}

/** One nest's channels; the caller must be a person added to it. */
export async function searchChannelMessages(caller: Caller, nestName: string | null, input: SearchInput): Promise<SearchResult> {
  if (!(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Not found");
  return search(caller, new Map([[caller.nestId, nestName ?? caller.nestId]]), input);
}

/** Every nest (id → name) the caller is a member of. */
export async function searchAcrossNests(
  who: { userId: string; userEmail: string },
  visible: Map<string, string>,
  input: SearchInput,
): Promise<SearchResult> {
  const member = new Map<string, string>();
  for (const [id, name] of visible) if (await isNestMember(id, who.userId).catch(() => false)) member.set(id, name);
  return search(who, member, input);
}

/**
 * The message hits the DOCUMENT search routes add to their answer
 * (`messages` on GET /nests/:id/search, GET /search and context_search):
 * the same query over the channels the caller can read, newest first, at
 * most `limit`. `null` while channels are off — the key is then left out,
 * so the document search's wire shape is exactly what it was. `[]` for a
 * non-member and for a query the message search refuses (shorter than two
 * characters). Never fails the document search.
 */
export async function messageHitsForDocumentSearch(
  who: { userId: string; userEmail: string },
  nestNames: Map<string, string>,
  q: string,
  limit: number,
): Promise<SearchHit[] | null> {
  try {
    const { config } = await import("../config.js");
    if (!config.EXPERIMENTAL_AGENT_STREAM) return null;
    const r = await searchAcrossNests(who, nestNames, { q, limit: Math.min(Math.max(limit, 1), SEARCH_PAGE_MAX) });
    return r.results;
  } catch (err) {
    if (err instanceof ValidationError) return [];
    console.error("[search] message hits failed", err);
    return [];
  }
}
