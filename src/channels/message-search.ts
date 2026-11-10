/**
 * Message search over channels (PO-1196, team chat C1): one nest
 * (`GET /nests/:id/channels/search`) or every nest the caller is a member
 * of (`GET /me/chat/search`); MCP `context_channel_search`.
 *
 * HOW: this server keeps no full-text index of messages (nothing in the
 * project uses SQLite FTS), so this is a bounded `LIKE`. The query is split
 * into terms (at most MAX_TERMS, each escaped for LIKE); every term must
 * occur in the body, case-insensitively (`LOWER(body) LIKE LOWER(?)` is the
 * same statement on SQLite and Postgres). The database considers only
 * channel messages that are not tombstones, in the nests given, newest
 * first, and STOPS at SCAN_CEILING matches: a search considers at most the
 * 1,000 newest matching messages, then filters them to the channels the
 * caller can read and pages what is left. Older matches are reached by
 * passing `before=` (a timestamp or a message id). The ceiling is returned
 * on every response (`ceiling`) so a client can say so.
 *
 * Members only: non-members get NotFound, the same as any channel read. The
 * `from` filter takes a login (an email) or "me"; a display name is not a
 * search key, so a non-member can never use this to test who is on a nest.
 */
import { getDb } from "../db/client.js";
import { canOpenNode } from "../governance/mention-notify.js";
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

export const SEARCH_SCAN_CEILING = 1000;
export const SEARCH_PAGE_DEFAULT = 20;
export const SEARCH_PAGE_MAX = 50;
const MAX_SEARCH_OFFSET = SEARCH_SCAN_CEILING;
const MAX_QUERY_LENGTH = 200;
const MAX_TERMS = 8;
const EXCERPT_RADIUS = 80;

export interface SearchHit extends ChannelNewMessage {
  nest_id: string;
  nest_name: string;
  channel: string;
  message_id: string;
  /** A window of the body around the first match, whitespace collapsed. */
  excerpt: string;
  /** Where the terms occur IN THE EXCERPT (character offsets, end exclusive). */
  highlights: Array<{ start: number; end: number }>;
}

export interface SearchResult {
  results: SearchHit[];
  pagination: { limit: number; offset: number; has_more: boolean };
  /** Most matching messages one search considers (the newest ones). */
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

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function parseTerms(raw: unknown): string[] {
  if (typeof raw !== "string") throw new ValidationError("q is required — what to search for (at least 2 characters).");
  const q = raw.trim();
  if (q.length < 2) throw new ValidationError("q is at least 2 characters.");
  if (q.length > MAX_QUERY_LENGTH) throw new ValidationError(`q is at most ${MAX_QUERY_LENGTH} characters.`);
  const terms = [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
  if (terms.length === 0) throw new ValidationError("q is at least 2 characters.");
  return terms;
}

/** "2026-11-09T13:41:44.927Z" → "2026-11-09 13:41:44.927", the stored form. */
function toStored(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/** A `before` / `after` value → a stored timestamp to compare created_at with. */
async function timeBound(nestIds: string[], raw: unknown, name: string): Promise<string | null> {
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
    `SELECT c.created_at FROM annotation_comments c JOIN annotation_threads t ON t.id = c.thread_id
      WHERE c.id = ? AND t.nest_id IN (${nestIds.map(() => "?").join(", ")})`,
    [value, ...nestIds],
  )) as { created_at: string } | undefined;
  if (!row) throw refuse();
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

/** The excerpt around the first term and every term's place in it. */
export function excerptWithHighlights(body: string, terms: string[]): { excerpt: string; highlights: Array<{ start: number; end: number }> } {
  const flat = String(body ?? "").replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let first = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  const start = first < 0 ? 0 : Math.max(0, first - EXCERPT_RADIUS);
  const end = Math.min(flat.length, (first < 0 ? 0 : first) + EXCERPT_RADIUS * 2);
  const excerpt = `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
  const lead = start > 0 ? 1 : 0;
  const window = lower.slice(start, end);
  const highlights: Array<{ start: number; end: number }> = [];
  for (const t of terms) {
    let i = window.indexOf(t);
    while (i >= 0) {
      highlights.push({ start: lead + i, end: lead + i + t.length });
      i = window.indexOf(t, i + t.length);
    }
  }
  highlights.sort((a, b) => a.start - b.start);
  return { excerpt, highlights };
}

type HitRow = CommentRow & { nest_id: string; node_id: string };

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
  const terms = parseTerms(input.q);
  const { limit, offset } = parsePage(input);
  const nestIds = [...nestNames.keys()];
  if (nestIds.length === 0) return { results: [], pagination: { limit, offset, has_more: false }, ceiling: SEARCH_SCAN_CEILING };
  takeOrRefuse(`chat-search:${who.userId}`, SEARCH_LIMIT, "searches");

  const where: string[] = [`t.nest_id IN (${nestIds.map(() => "?").join(", ")})`, "t.node_id LIKE 'nodes/channels/%'", "c.deleted_at IS NULL"];
  const params: unknown[] = [...nestIds];
  for (const t of terms) {
    where.push("LOWER(c.body) LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(t)}%`);
  }
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
  const before = await timeBound(nestIds, input.before, "before");
  const after = await timeBound(nestIds, input.after, "after");
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

  // Which of the matched channels this caller can read, once per channel.
  const readable = new Map<string, boolean>();
  for (const r of rows) {
    const k = `${r.nest_id}\u0000${r.node_id}`;
    if (readable.has(k)) continue;
    readable.set(
      k,
      !!channelNameOf(r.node_id) &&
        (await isChannelNode(r.nest_id, r.node_id).catch(() => false)) &&
        (await canOpenNode(r.nest_id, r.node_id, who.userId, who.userEmail).catch(() => false)),
    );
  }
  const shown = rows.filter((r) => readable.get(`${r.nest_id}\u0000${r.node_id}`));
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
    results: page.map((r) => ({
      ...built.get(r.id)!,
      nest_id: r.nest_id,
      nest_name: nestNames.get(r.nest_id) ?? r.nest_id,
      channel: channelNameOf(r.node_id)!,
      message_id: r.id,
      ...excerptWithHighlights(r.body, terms),
    })),
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
