/**
 * Pinned nests (PO-1441; the pin itself is CU-wdqcq00d63).
 *
 * A pin is one person's bookmark on a nest: `nest_pins` on the server,
 * `pinned` on every `GET /nests` row, toggled with POST/DELETE
 * /nests/:id/pin. The All nests grid already floated pins to the top; this
 * module is what the left rail, the nest header and the grid share, so every
 * pin control moves the same cached row the same way.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { reads } from "./queries";
import { setNestPinned } from "./api";

interface RailNest {
  id: string;
  name?: string | null;
  pinned?: boolean;
}

/**
 * The rail's nest order: pinned nests first, then the rest. Inside each group
 * it is the order the rail always had — the nest on screen first (so the tree
 * you are in is never below the fold), then by name. The name filter keeps
 * the nest on screen, as before. Returns a new array; the cached list is not
 * reordered.
 */
export function railNestRows<T extends RailNest>(
  list: T[],
  currentNestId: string | null,
  filter: string,
): T[] {
  const q = filter.trim().toLowerCase();
  return list
    .filter((n) => !q || n.id === currentNestId || String(n.name).toLowerCase().includes(q))
    .sort((a, b) => {
      const pin = Number(!!b.pinned) - Number(!!a.pinned);
      if (pin !== 0) return pin;
      if (a.id === currentNestId) return -1;
      if (b.id === currentNestId) return 1;
      return String(a.name).localeCompare(String(b.name));
    });
}

/** The cached `GET /nests` payload with one nest's `pinned` set. */
export function withNestPinned<P extends { nests: RailNest[] }>(
  prev: P | undefined,
  nestId: string,
  pinned: boolean,
): P | undefined {
  if (!prev) return prev;
  return {
    ...prev,
    nests: prev.nests.map((n) => (n.id === nestId ? { ...n, pinned } : n)),
  };
}

/**
 * Pin or unpin optimistically: patch first, so the row moves on the click,
 * then write. On failure the patch is rolled back and the error reported — a
 * nest that silently stays (un)pinned is worse than a toast. Resolves true
 * when the write landed.
 */
export async function toggleNestPin({
  nestId,
  pinned,
  patch,
  request,
  onError,
}: {
  nestId: string;
  pinned: boolean;
  patch: (pinned: boolean) => void;
  request: (nestId: string, pinned: boolean) => Promise<unknown>;
  onError: (err: unknown) => void;
}): Promise<boolean> {
  patch(pinned);
  try {
    await request(nestId, pinned);
    return true;
  } catch (err) {
    patch(!pinned);
    onError(err);
    return false;
  }
}

/**
 * The pin toggle every control uses (All nests card, rail row, nest header).
 * It patches the live nest list the rail and the grid both read; the write's
 * own invalidation (`/pin` → nestList, queries.ts) then reconciles it. A second
 * click on the same nest while the first is in flight is ignored.
 */
export function useNestPin() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const toggle = async (nestId: string, pinned: boolean) => {
    if (busy.has(nestId)) return;
    setBusy((prev) => new Set(prev).add(nestId));
    try {
      await toggleNestPin({
        nestId,
        pinned,
        patch: (value) =>
          qc.setQueryData(reads.nestList().queryKey, (prev: any) => withNestPinned(prev, nestId, value)),
        request: setNestPinned,
        onError: (err: any) =>
          toast.error(err?.message ?? `Failed to ${pinned ? "pin" : "unpin"} this nest`),
      });
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(nestId);
        return next;
      });
    }
  };
  return { toggle, busy };
}
