/**
 * One side panel at a time (PO-1200, AC-C3-07): Hootie and the chat share
 * the right edge, so opening one closes the other. A tiny store outside
 * React, read with `useSidePanel`, so the two panels need no common parent.
 */
import { useCallback, useSyncExternalStore } from "react";

export type SidePanelId = "hootie" | "chat";

/** The rule, on values: what is open after `action` on `id`. */
export function nextSidePanel(current: SidePanelId | null, id: SidePanelId, action: "open" | "close" | "toggle"): SidePanelId | null {
  if (action === "open") return id;
  if (action === "close") return current === id ? null : current;
  return current === id ? null : id;
}

let current: SidePanelId | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function currentSidePanel(): SidePanelId | null {
  return current;
}

export function setSidePanel(id: SidePanelId, action: "open" | "close" | "toggle"): void {
  const next = nextSidePanel(current, id, action);
  if (next === current) return;
  current = next;
  emit();
}

/** Tests: start from nothing open. */
export function resetSidePanels(): void {
  current = null;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** `[open, setOpen]` for one panel; setting it open closes the other. */
export function useSidePanel(id: SidePanelId): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(subscribe, () => current === id, () => false);
  const set = useCallback((to: boolean) => setSidePanel(id, to ? "open" : "close"), [id]);
  return [open, set];
}
