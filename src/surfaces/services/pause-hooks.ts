/**
 * What has to happen when a binding stops capturing — the guard pauses it, a
 * member boots it, or it is removed: purge that conversation's buffer and
 * withdraw its pending cards (no 7-day hold). The buffer and proposals arrive
 * in S2a/S2b; they register here, so the binding state machine (S1) never
 * has to know about them.
 */
export type PauseReason = "guard" | "member_boot" | "removed";

export interface PausedBinding {
  id: string;
  install_id: string;
  nest_id: string;
  conversation_id: string;
}

type Hook = (binding: PausedBinding, reason: PauseReason) => Promise<void> | void;

const hooks: Hook[] = [];

export function onBindingPaused(hook: Hook): () => void {
  hooks.push(hook);
  return () => {
    const i = hooks.indexOf(hook);
    if (i >= 0) hooks.splice(i, 1);
  };
}

/**
 * §4.17: `surface_ok` true → false on a binding that stays live. Cards already
 * posted there are re-rendered to the redacted variant (S2b registers this).
 */
type SurfaceOkHook = (binding: PausedBinding) => Promise<void> | void;
const surfaceOkHooks: SurfaceOkHook[] = [];
export function onSurfaceOkLost(hook: SurfaceOkHook): () => void {
  surfaceOkHooks.push(hook);
  return () => {
    const i = surfaceOkHooks.indexOf(hook);
    if (i >= 0) surfaceOkHooks.splice(i, 1);
  };
}
export async function runSurfaceOkLostHooks(binding: PausedBinding): Promise<void> {
  for (const h of surfaceOkHooks) {
    try {
      await h(binding);
    } catch (err) {
      console.error(`[surfaces] surface_ok hook failed for binding ${binding.id}:`, err instanceof Error ? err.name : "error");
    }
  }
}

/** Work that rides every guard sweep (S2b: retrying card redactions). */
type SweepHook = () => Promise<unknown> | unknown;
const sweepHooks: SweepHook[] = [];
export function onGuardSweep(hook: SweepHook): () => void {
  sweepHooks.push(hook);
  return () => {
    const i = sweepHooks.indexOf(hook);
    if (i >= 0) sweepHooks.splice(i, 1);
  };
}
export async function runGuardSweepHooks(): Promise<void> {
  for (const h of sweepHooks) {
    try {
      await h();
    } catch (err) {
      console.error("[surfaces] guard sweep hook failed:", err instanceof Error ? err.name : "error");
    }
  }
}

export async function runPauseHooks(binding: PausedBinding, reason: PauseReason): Promise<void> {
  for (const h of hooks) {
    try {
      await h(binding, reason);
    } catch (err) {
      console.error(`[surfaces] pause hook failed for binding ${binding.id}:`, err);
    }
  }
}
