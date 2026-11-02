/**
 * Guard re-check loop (§4.17).
 *
 * Triggers mark bindings `guard_dirty`:
 *  - surface signals (members joined/left, shared/unshared, user changes) via
 *    handleSurfaceSignal;
 *  - Community changes via invalidate.ts, and — for every permission path,
 *    including ones no call site flags — the reader fingerprint: each tick
 *    recomputes EffectiveReaders for every live binding's nest and marks the
 *    binding dirty when it changed (share, visibility, link sharing, server
 *    admins, keys, agents, connectors, teams, stewards, grants);
 *  - the 24h periodic re-check.
 *
 * The tick (GUARD_TICK_MS ≤ 60 s, never overlapping) recomputes every dirty
 * binding, so a change is applied within 60 s. Multi-instance safe: every
 * status write is a compare-and-set on (status, version), and guard_dirty is
 * cleared only against the dirty epoch the re-check started from.
 */
import { getDb } from "../../db/client.js";
import type { SurfaceSignal } from "../contract.js";
import { invalidateConversationGuards, invalidateInstallGuards } from "../invalidate.js";
import { surfacesEnabled } from "../flags.js";
import { effectiveReaders } from "./readers.js";
import { failClosedBinding, markRemoved, recheckBinding, type BindingRow } from "./binding-service.js";

export { onBindingPaused } from "./pause-hooks.js";

export const GUARD_TICK_MS = 30_000;

/** Test-only hook point (inert in production). */
export const guardRunnerTestHooks: { beforeFingerprint?: (nestId: string) => unknown } = {};
export const GUARD_PERIODIC_MS = 24 * 60 * 60_000;

export async function handleSurfaceSignal(installId: string, signal: SurfaceSignal): Promise<void> {
  switch (signal.kind) {
    case "member_joined":
    case "member_left":
    case "conversation_shared":
    case "conversation_unshared":
      if (signal.conversation) await invalidateConversationGuards(installId, signal.conversation);
      return;
    case "user_change":
      await invalidateInstallGuards(installId);
      return;
    case "conversation_archived":
    case "conversation_deleted":
    case "bot_removed": {
      if (!signal.conversation) return;
      const rows = (await getDb().all("SELECT * FROM surface_bindings WHERE install_id = ? AND conversation_id = ?", [
        installId,
        signal.conversation,
      ])) as BindingRow[];
      for (const r of rows) await markRemoved(r);
      return;
    }
    case "uninstalled":
    case "tokens_revoked": {
      await getDb().run("UPDATE surface_installs SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?", [
        new Date().toISOString(),
        new Date().toISOString(),
        installId,
      ]);
      const rows = (await getDb().all("SELECT * FROM surface_bindings WHERE install_id = ?", [installId])) as BindingRow[];
      for (const r of rows) await markRemoved(r);
      return;
    }
  }
}

/**
 * One pass: detect reader changes, then recompute every dirty or stale live
 * binding. Returns the ids recomputed. Exported for tests (pass a fake now).
 */
export async function runGuardSweep(now: number = Date.now()): Promise<string[]> {
  const db = getDb();
  const live = (await db.all("SELECT * FROM surface_bindings WHERE status IN ('active', 'paused_guard')")) as BindingRow[];
  const fingerprints = new Map<string, string | null>();
  const due: string[] = [];
  for (const b of live) {
    const key = `${b.nest_id}\u0000${b.listener_agent_node_id ?? ""}`;
    if (!fingerprints.has(key)) {
      try {
        await guardRunnerTestHooks.beforeFingerprint?.(b.nest_id);
        fingerprints.set(key, (await effectiveReaders(b.nest_id, { listenerAgentNodeId: b.listener_agent_node_id })).fingerprint);
      } catch (err) {
        // This nest's readers can't be computed: fail its bindings closed and
        // carry on with every other nest (M1).
        console.error(`[surfaces] reader computation failed for nest ${b.nest_id}; failing its bindings closed`, err instanceof Error ? err.message : err);
        fingerprints.set(key, null);
      }
    }
    if (fingerprints.get(key) === null) {
      await failClosedBinding(b.id).catch(() => {});
      continue;
    }
    const changed = b.readers_fingerprint !== fingerprints.get(key);
    const stale = !b.guard_checked_at || now - Date.parse(b.guard_checked_at) >= GUARD_PERIODIC_MS;
    if (b.guard_dirty || changed || stale) due.push(b.id);
  }
  const done: string[] = [];
  for (const id of due) {
    try {
      await recheckBinding(id);
      done.push(id);
    } catch (err) {
      // recheckBinding fails closed itself; this covers a throw before it got
      // that far (e.g. reading the row). Never leave a binding live on error.
      console.error(`[surfaces] guard re-check failed for binding ${id}:`, err instanceof Error ? err.message : err);
      await failClosedBinding(id).catch(() => {});
    }
  }
  return done;
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<string[]> | null = null;

/**
 * One loop tick. Ticks never overlap (security L3): while a sweep is still
 * running, a tick is skipped rather than racing it.
 */
export async function guardTick(now: number = Date.now()): Promise<string[] | "skipped"> {
  if (inFlight) return "skipped";
  inFlight = runGuardSweep(now);
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Start the loop. Always runs; each tick is a no-op while Surfaces is off, so
 *  turning metacognition on at runtime can't leave live bindings unchecked. */
export function startSurfacesGuardLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (!surfacesEnabled()) return;
    void guardTick().catch((err) => console.error("[surfaces] guard sweep failed", err));
  }, GUARD_TICK_MS);
  timer.unref?.();
}

export function stopSurfacesGuardLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
