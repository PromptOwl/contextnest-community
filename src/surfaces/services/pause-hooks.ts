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

export async function runPauseHooks(binding: PausedBinding, reason: PauseReason): Promise<void> {
  for (const h of hooks) {
    try {
      await h(binding, reason);
    } catch (err) {
      console.error(`[surfaces] pause hook failed for binding ${binding.id}:`, err);
    }
  }
}
