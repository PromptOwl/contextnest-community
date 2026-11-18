/**
 * Presence and typing (team chat harness C2, PO-1197). In memory only.
 *
 * A heartbeat (`POST /nests/:id/chat/presence`) marks a member active for
 * PRESENCE_TTL_MS with an optional short status; `GET` lists who is active.
 * Shown to members of the nest only, with `last_seen` rounded down to the
 * minute: presence tells a team who is around, it is not a log of when each
 * person touched the app (presence as a tracking vector, security review).
 * Agents heartbeat too, through the key they run on, declaring
 * `client.agent`; they are listed as the agent.
 *
 * Typing is never stored: `POST …/chat/typing` only emits an event.
 */
import { tryConsume } from "../shared/rate-limit.js";
import { ValidationError } from "../shared/errors.js";
import { displayNames, normHandle } from "../channels/message-meta.js";
import { resolveActorLabel } from "../channels/actor-label.js";
import { emitChatEvent } from "./events.js";

export const PRESENCE_TTL_MS = 5 * 60_000;
export const MAX_STATUS_LENGTH = 80;
/** Heartbeats one person may send per nest per minute. */
export const PRESENCE_BUDGET = { max: 30, windowMs: 60_000 };
/** Typing signals one person may send per nest per minute. */
export const TYPING_BUDGET = { max: 120, windowMs: 60_000 };

interface Entry {
  userId: string;
  email: string;
  agent: string | null;
  status: string | null;
  at: number;
}

export interface PresenceRow {
  email: string;
  name: string;
  agent: string | null;
  label: string;
  status: string | null;
  /** ISO, rounded down to the minute. */
  last_seen: string;
}

const byNest = new Map<string, Map<string, Entry>>();
let clock: (() => number) | null = null;
const now = () => (clock ? clock() : Date.now());

/** Tests only: pretend it is later. */
export function _setPresenceClock(fn: (() => number) | null): void {
  clock = fn;
}

export function parseStatus(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new ValidationError("status must be a string");
  const s = raw.replace(/\s+/g, " ").trim();
  if (s.length > MAX_STATUS_LENGTH) throw new ValidationError(`status is at most ${MAX_STATUS_LENGTH} characters`);
  return s || null;
}

function sweep(map: Map<string, Entry>, cutoff: number): void {
  for (const [k, e] of map) if (e.at < cutoff) map.delete(k);
}

/** Record a heartbeat. Returns false when the caller is over budget. */
export function heartbeat(nestId: string, who: { userId: string; email: string; agent?: string | null }, status: string | null): boolean {
  if (!tryConsume(`chat-presence:${nestId}:${who.userId}`, PRESENCE_BUDGET)) return false;
  let map = byNest.get(nestId);
  if (!map) byNest.set(nestId, (map = new Map()));
  const agent = who.agent ? normHandle(who.agent) || null : null;
  const key = `${who.userId}\u0000${agent ?? ""}`;
  const t = now();
  map.set(key, { userId: who.userId, email: who.email.toLowerCase(), agent, status, at: t });
  sweep(map, t - PRESENCE_TTL_MS);
  emitChatEvent(nestId, { type: "presence", email: who.email.toLowerCase(), agent, status, active: true });
  return true;
}

function minuteIso(ms: number): string {
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

/** Everyone active in the nest within the last PRESENCE_TTL_MS. */
export async function activePresence(nestId: string): Promise<PresenceRow[]> {
  const map = byNest.get(nestId);
  if (!map) return [];
  const t = now();
  sweep(map, t - PRESENCE_TTL_MS);
  const entries = [...map.values()].sort((a, b) => b.at - a.at);
  const names = await displayNames(entries.map((e) => e.email));
  return Promise.all(
    entries.map(async (e) => {
      const name = names.get(e.email) ?? e.email;
      const actor = await resolveActorLabel({ email: e.email, client: e.agent ? { agent: e.agent } : undefined });
      // The seam answers in emails; show the display name as the timeline does.
      const label = actor.agent ? actor.label.replace(e.email, () => name) : name;
      return { email: e.email, name, agent: e.agent, label, status: e.status, last_seen: minuteIso(e.at) };
    }),
  );
}

/** Emit a typing signal; false when over budget. Nothing is stored. */
export function typing(nestId: string, container: string, who: { userId: string; email: string; name: string; agent?: string | null }): boolean {
  if (!tryConsume(`chat-typing:${nestId}:${who.userId}`, TYPING_BUDGET)) return false;
  emitChatEvent(nestId, {
    type: "typing",
    conversation: container,
    who: { email: who.email.toLowerCase(), name: who.name, agent: who.agent ? normHandle(who.agent) || null : null },
  });
  return true;
}

/** Tests only. */
export function _resetPresence(): void {
  byNest.clear();
}
