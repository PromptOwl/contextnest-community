/**
 * Document access events — reads, retrievals and exports (CU-wdqcq03aw2).
 *
 * An edit leaves a version row; a read leaves nothing. The activity trace
 * (api_events) records the call but not which documents it returned, so an
 * admin asking "who pulled this document?" had no answer. This records one
 * row per (actor, document, action):
 *
 *   read      — the document itself was opened (REST GET, MCP context_get)
 *   retrieve  — it came back from a search / query / context call
 *   export    — it left in an export; a whole-nest export is ONE row with
 *               node_id NULL, shown in every document's and folder's log
 *
 * Kept deliberately cheap, because it sits on the read path:
 *   - fire-and-forget: callers never await it, and a broken table never
 *     fails a read (same contract as the activity trace);
 *   - throttled: the same actor + document + action is recorded at most once
 *     per THROTTLE_MS, so an agent re-reading a doc in a loop is one row;
 *   - capped: at most MAX_PER_CALL documents per retrieval;
 *   - pruned on the activity trace's retention window.
 *
 * `client` is self-reported attribution (§9.4) — shown, never trusted.
 * `detail` names the surface ("search", "context_get"), never what the caller
 * typed: admins read this log, and a search box or a Hootie prompt is not
 * theirs to read.
 */
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { serializeClient, type ClientMetadata } from "../shared/client-metadata.js";

export type AccessAction = "read" | "retrieve" | "export";
export type AccessSurface = "api" | "mcp";

export const THROTTLE_MS = 10 * 60_000;
/** Documents recorded per retrieval (a search can return hundreds). */
export const MAX_PER_CALL = 50;
/** Documents recorded per selector export — larger, since each one left. */
export const MAX_PER_EXPORT = 1000;
const THROTTLE_MAX_KEYS = 20_000;
const PRUNE_EVERY = 500;

/**
 * Process-wide state: actor|nest|node|action|surface|agent → last recorded at
 * (ms), plus in-flight inserts. Held on globalThis so a module re-evaluation
 * (tests re-import the app) still shares one throttle and one flush queue.
 * Bounded: the throttle map is cleared when full.
 */
const STATE_KEY = Symbol.for("contextnest.accessLog");
const state: { lastSeen: Map<string, number>; pending: Set<Promise<void>> } =
  ((globalThis as any)[STATE_KEY] ??= { lastSeen: new Map(), pending: new Set() });
const { lastSeen, pending } = state;
let insertsSincePrune = 0;

export interface AccessEvent {
  nestId: string;
  /** Documents accessed; empty or omitted with `wholeNest` for a nest export. */
  nodeIds?: string[];
  wholeNest?: boolean;
  action: AccessAction;
  surface: AccessSurface;
  userId?: string | null;
  userEmail?: string | null;
  client?: ClientMetadata;
  /** How it was accessed ("search", "markdown export (12 documents)").
   *  Never the caller's query or prompt text. */
  detail?: string;
}

/** A different surface or agent is a different fact ("hootie read it" is not
 *  "alice opened it"), so both are part of the throttle key. */
function admit(
  actor: string,
  nestId: string,
  nodeId: string | null,
  e: AccessEvent,
  now: number,
) {
  const agent = typeof e.client?.agent === "string" ? e.client.agent : "";
  const key = `${actor}|${nestId}|${nodeId ?? "*"}|${e.action}|${e.surface}|${agent}`;
  const prev = lastSeen.get(key);
  if (prev !== undefined && now - prev < THROTTLE_MS) return false;
  // Evict the oldest tenth rather than clearing: a full clear re-records
  // everything at exactly the moment the server is busiest. Map iteration is
  // insertion order, and a key is re-inserted when refreshed, so the first
  // entries are the stalest.
  if (lastSeen.size >= THROTTLE_MAX_KEYS) {
    let drop = Math.ceil(THROTTLE_MAX_KEYS / 10);
    for (const k of lastSeen.keys()) {
      lastSeen.delete(k);
      if (--drop <= 0) break;
    }
  }
  lastSeen.delete(key);
  lastSeen.set(key, now);
  return true;
}

/** Undo admit() for keys whose insert failed, so the next access is retried
 *  rather than suppressed for the whole window. */
function release(actor: string, e: AccessEvent, targets: Array<string | null>) {
  const agent = typeof e.client?.agent === "string" ? e.client.agent : "";
  for (const nodeId of targets) {
    lastSeen.delete(`${actor}|${e.nestId}|${nodeId ?? "*"}|${e.action}|${e.surface}|${agent}`);
  }
}

async function write(e: AccessEvent, targets: Array<string | null>, actor: string): Promise<void> {
  try {
    const db = getDb();
    const ts = new Date().toISOString();
    const client = serializeClient(e.client);
    const detail = e.detail ? e.detail.slice(0, 200) : null;
    for (const nodeId of targets) {
      await db.run(
        `INSERT INTO node_access_events
           (ts, nest_id, node_id, action, surface, user_id, user_email, client_json, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ts, e.nestId, nodeId, e.action, e.surface, e.userId ?? null, e.userEmail ?? null, client, detail],
      );
    }
    insertsSincePrune += targets.length;
    if (insertsSincePrune >= PRUNE_EVERY) {
      insertsSincePrune = 0;
      const days = config.TRACE_RETENTION_DAYS;
      if (days > 0) {
        const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
        await db.run("DELETE FROM node_access_events WHERE ts < ?", [cutoff]);
      }
    }
  } catch {
    // Recording access must never break a read — but a failed insert must
    // not silence this actor for the rest of the window either.
    release(actor, e, targets);
  }
}

/**
 * Record document access. Returns immediately; the insert runs in the
 * background. Anonymous callers (no user) are recorded as such only when the
 * read was attributable — a caller with neither id nor email is skipped.
 */
export function recordNodeAccess(e: AccessEvent): void {
  try {
    const actor = e.userEmail || e.userId;
    if (!actor || !e.nestId) return;
    const now = Date.now();
    const ids = e.wholeNest
      ? [null]
      : [...new Set((e.nodeIds || []).filter((id) => typeof id === "string" && id))].slice(
          0,
          e.action === "export" ? MAX_PER_EXPORT : MAX_PER_CALL,
        );
    const targets = ids.filter((id) => admit(actor, e.nestId, id, e, now));
    if (!targets.length) return;
    const p = write(e, targets, actor);
    pending.add(p);
    void p.finally(() => pending.delete(p));
  } catch {
    /* never break the caller */
  }
}

/** Wait for in-flight inserts (tests, and the log endpoint's read-your-writes). */
export async function flushAccessLog(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** Forget the throttle window (tests). */
export function resetAccessThrottle(): void {
  lastSeen.clear();
}
