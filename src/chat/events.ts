/**
 * The in-process chat event bus (team chat harness C2, PO-1197).
 *
 * Every write path that changes what a chat screen shows calls
 * `emitChatEvent(nestId, event)` — one line in post-message.ts and
 * channel-service.ts, and the chat routes for presence, typing, membership.
 * Anything a later slice adds to a message (a reaction, an edit, a pin)
 * emits the GENERIC `message.changed { conversation, thread_id, message_id,
 * change? }`, so a client re-reads that message; nothing here depends on
 * those features existing.
 *
 * Subscribers are the SSE streams in routes.ts (`GET /nests/:id/chat/events`).
 * Each event gets an id from one process-wide counter and is kept in a short
 * per-nest ring buffer, so a client that reconnects with `Last-Event-ID` gets
 * what it missed while the buffer still holds it, and a `reset` event when it
 * doesn't (then it re-reads with `?since=`). One process only: on a
 * horizontally scaled deployment a client sees the events of the instance it
 * is connected to, which is why the UI contract says to poll as a fallback.
 *
 * Events carry POINTERS (ids, who), never message text: the read carries the
 * text, under the reader's own access rules.
 */
import { tryConsume } from "../shared/rate-limit.js";

export type ChatEventType =
  | "hello"
  | "message.new"
  | "message.changed"
  | "read.marked"
  | "typing"
  | "presence"
  | "channel.created"
  | "channel.archived"
  | "conversation.created"
  | "membership.changed"
  | "reset";

export interface ChatEvent {
  type: ChatEventType | (string & {});
  /** The container the event is about (a channel node id or a conversation
   *  id), when it is about one: used to deliver it to its members only. */
  conversation?: string;
  [key: string]: unknown;
}

export interface StoredChatEvent {
  id: number;
  nestId: string;
  at: number;
  event: ChatEvent;
  /** Delivered to this user id only (their own read mark). */
  only?: string;
}

export interface ChatSubscriber {
  userId: string;
  deliver: (ev: StoredChatEvent) => void;
}

/** Events kept per nest for Last-Event-ID resume. */
export const RING_SIZE = 500;
/** Open streams one person may hold per nest. */
export const MAX_STREAMS_PER_USER = 5;
/** New stream connections one person may open per minute (per nest). */
export const STREAM_CONNECT_BUDGET = { max: 60, windowMs: 60_000 };
const DEFAULT_HEARTBEAT_MS = 20_000;

let seq = 0;
const rings = new Map<string, StoredChatEvent[]>();
const subscribers = new Map<string, Set<ChatSubscriber>>();
let heartbeatOverride: number | null = null;

/** Events that mean nothing after the moment: delivered live, never
 *  buffered, so a typing storm can't push real events out of the resume
 *  buffer (security review, resource exhaustion). */
const EPHEMERAL = new Set<string>(["typing", "presence"]);

export function emitChatEvent(nestId: string, event: ChatEvent, opts: { only?: string } = {}): StoredChatEvent {
  const stored: StoredChatEvent = { id: ++seq, nestId, at: Date.now(), event, ...(opts.only ? { only: opts.only } : {}) };
  if (!EPHEMERAL.has(String(event.type))) {
    let ring = rings.get(nestId);
    if (!ring) rings.set(nestId, (ring = []));
    ring.push(stored);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  }
  const subs = subscribers.get(nestId);
  if (subs) {
    for (const s of subs) {
      if (stored.only && stored.only !== s.userId) continue;
      try {
        s.deliver(stored);
      } catch {
        /* a dead stream drops itself on its next write */
      }
    }
  }
  return stored;
}

export function subscribeChat(nestId: string, sub: ChatSubscriber): () => void {
  let subs = subscribers.get(nestId);
  if (!subs) subscribers.set(nestId, (subs = new Set()));
  subs.add(sub);
  return () => {
    const set = subscribers.get(nestId);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) subscribers.delete(nestId);
  };
}

/**
 * What a reconnecting client missed: the buffered events after `lastId`,
 * or `tooOld` when `lastId` predates what the buffer still holds (the client
 * must re-read). A `lastId` that is not a number resumes nothing.
 */
export function replaySince(nestId: string, lastId: string | undefined): { events: StoredChatEvent[]; tooOld: boolean } {
  const n = Number(lastId);
  if (!lastId || !Number.isFinite(n) || n < 0) return { events: [], tooOld: false };
  const ring = rings.get(nestId) ?? [];
  if (n >= seq) return { events: [], tooOld: false };
  // Complete only if nothing buffered for this nest was dropped after `n`:
  // the buffer must still reach back to `n` (ephemeral events are never in
  // it, and other nests' ids interleave, so "the next id" is not the test).
  if (ring.length === 0) return { events: [], tooOld: false };
  if (ring.length >= RING_SIZE && ring[0].id > n) return { events: [], tooOld: true };
  return { events: ring.filter((e) => e.id > n), tooOld: false };
}

export function latestEventId(): number {
  return seq;
}

export function heartbeatMs(): number {
  return heartbeatOverride ?? DEFAULT_HEARTBEAT_MS;
}

/** Tests only. */
export function _setHeartbeatMs(ms: number | null): void {
  heartbeatOverride = ms;
}

/** Open streams on a nest (optionally one person's). Tests and the connection cap. */
export function _subscriberCount(nestId: string, userId?: string): number {
  const subs = subscribers.get(nestId);
  if (!subs) return 0;
  if (!userId) return subs.size;
  let n = 0;
  for (const s of subs) if (s.userId === userId) n++;
  return n;
}

/** May this person open one more stream on this nest right now? */
export function mayOpenStream(nestId: string, userId: string): "ok" | "too_many" | "too_fast" {
  if (_subscriberCount(nestId, userId) >= MAX_STREAMS_PER_USER) return "too_many";
  if (!tryConsume(`chat-stream:${nestId}:${userId}`, STREAM_CONNECT_BUDGET)) return "too_fast";
  return "ok";
}
