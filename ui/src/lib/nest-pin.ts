/**
 * Pinned nests (PO-1441; the pin itself is CU-wdqcq00d63).
 *
 * A pin is one person's bookmark on a nest: `nest_pins` on the server,
 * `pinned` on every `GET /nests` row, toggled with POST/DELETE
 * /nests/:id/pin. The All nests grid already floated pins to the top; this
 * module is what the left rail, the nest header and the grid share, so every
 * pin control moves the same cached row the same way.
 */
import { useSyncExternalStore } from "react";
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
    .filter((n) => !q || n.id === currentNestId || String(n.name ?? "").toLowerCase().includes(q))
    .sort((a, b) => {
      const pin = Number(!!b.pinned) - Number(!!a.pinned);
      if (pin !== 0) return pin;
      if (a.id === currentNestId) return -1;
      if (b.id === currentNestId) return 1;
      return String(a.name ?? "").localeCompare(String(b.name ?? ""));
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
 * Nests with a pin write in flight, shared by EVERY control: the rail row and
 * the header toggle the same nest, so the guard can't be per instance (a
 * rollback from one would overwrite the other's optimistic state), and every
 * control for that nest shows as busy while it lasts.
 */
export function createPinGuard() {
  let inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  return {
    /** Claim the nest; false when a write for it is already in flight. */
    claim(nestId: string): boolean {
      if (inFlight.has(nestId)) return false;
      inFlight = new Set(inFlight).add(nestId);
      emit();
      return true;
    },
    release(nestId: string) {
      if (!inFlight.has(nestId)) return;
      inFlight = new Set(inFlight);
      inFlight.delete(nestId);
      emit();
    },
    snapshot: (): ReadonlySet<string> => inFlight,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const pinGuard = createPinGuard();

/**
 * The pin toggle every control uses (All nests card, rail row, nest header).
 * It patches the live nest list the rail and the grid both read; the write's
 * own invalidation (`/pin` → nestList, queries.ts) then reconciles it. While a
 * write for a nest is in flight, every control for that nest is busy and a
 * further click, from any of them, is ignored.
 */
export function useNestPin() {
  const qc = useQueryClient();
  const busy = useSyncExternalStore(pinGuard.subscribe, pinGuard.snapshot, pinGuard.snapshot);
  const toggle = async (nestId: string, pinned: boolean) => {
    if (!pinGuard.claim(nestId)) return;
    const key = reads.nestList().queryKey;
    try {
      // A list refetch already in flight would land after the optimistic patch
      // and flip the row back; the write's own invalidation refetches anyway.
      await qc.cancelQueries({ queryKey: key });
      await toggleNestPin({
        nestId,
        pinned,
        // Patch this nest only, both ways: a snapshot restore would also undo
        // any unrelated change that reached the list meanwhile. The guard
        // allows one write per nest at a time, so the inverse is exact.
        patch: (value) => qc.setQueryData(key, (prev: any) => withNestPinned(prev, nestId, value)),
        request: setNestPinned,
        onError: (err: any) =>
          toast.error(err?.message ?? `Failed to ${pinned ? "pin" : "unpin"} this nest`),
      });
    } finally {
      pinGuard.release(nestId);
    }
  };
  return { toggle, busy };
}
