/**
 * Two-tier save policy — the versioning guardrail.
 *
 * Going always-editable must NOT cut a `ctx` checkpoint per keystroke, or the
 * hash-chained history balloons. So edits flow through two tiers:
 *
 *   - DRAFT autosave  — cheap, debounced, overwrites the working copy.
 *                       NO checkpoint. Fires on the keystroke path.
 *   - VERSION checkpoint — only on coarse boundaries: blur, explicit save
 *                       (Cmd+S), navigate-away, or idle > idleMs. Coalesced:
 *                       skipped if nothing changed since the last checkpoint.
 *
 * Pure + framework-agnostic so the parent component can wire it to editor
 * events and it stays unit-testable without a DOM.
 */
export interface SavePolicyOptions {
  /** Cheap autosave of the working copy. Never creates a version. */
  onDraft: (content: string) => void;
  /** Create a `ctx` version checkpoint. Coarse boundaries only. */
  onCheckpoint: (content: string) => void;
  /** Debounce before a draft autosave fires. Default 800ms. */
  draftDebounceMs?: number;
  /** Idle gap after which a checkpoint is cut while still focused. Default 30s. */
  idleMs?: number;
}

export interface SavePolicy {
  /** Call on every editor update (the keystroke path). */
  change(content: string): void;
  /** Editor lost focus → checkpoint (coalesced). Returns true if one was cut. */
  blur(): boolean;
  /** Explicit save (Cmd+S) → checkpoint (coalesced). */
  explicitSave(): boolean;
  /** Navigating away from the doc → checkpoint (coalesced). */
  navigateAway(): boolean;
  /** Clear pending timers (unmount). */
  dispose(): void;
}

export function createSavePolicy(opts: SavePolicyOptions): SavePolicy {
  const { onDraft, onCheckpoint, draftDebounceMs = 800, idleMs = 30000 } = opts;

  let lastContent: string | null = null;
  let lastCheckpointed: string | null = null;
  let dirty = false;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function clearDraft() {
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
  }
  function clearIdle() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function checkpoint(): boolean {
    clearDraft();
    clearIdle();
    // Coalesce: nothing meaningful changed since the last checkpoint.
    if (!dirty || lastContent === null || lastContent === lastCheckpointed) {
      return false;
    }
    onCheckpoint(lastContent);
    lastCheckpointed = lastContent;
    dirty = false;
    return true;
  }

  return {
    change(content: string) {
      lastContent = content;
      if (content !== lastCheckpointed) dirty = true;

      clearDraft();
      draftTimer = setTimeout(() => {
        draftTimer = null;
        if (lastContent !== null) onDraft(lastContent);
      }, draftDebounceMs);

      clearIdle();
      idleTimer = setTimeout(() => {
        idleTimer = null;
        checkpoint();
      }, idleMs);
    },
    blur: checkpoint,
    explicitSave: checkpoint,
    navigateAway: checkpoint,
    dispose() {
      clearDraft();
      clearIdle();
    },
  };
}
