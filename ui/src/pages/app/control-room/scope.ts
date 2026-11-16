/**
 * Control room (po-1186 CR2): what every tab reads — the nest picker, the
 * range, and the nests the reader may see (decision 3: a server admin sees
 * every nest; anyone else the nests they own or administer).
 */
import { useEffect, useState } from "react";
import { rangeFor, type RangeDays } from "../../../lib/control-room-overview";

export interface NestRef {
  id: string;
  name: string;
}

export interface ControlRoomScope {
  /** null = all the nests the reader administers. */
  nestId: string | null;
  days: RangeDays;
  range: { from: string; to: string; days: string[] };
  nests: NestRef[];
  isServerAdmin: boolean;
  nestName: (id: string) => string;
  /** Bumped by "Refresh" and when the tab comes back into view, so reads re-run. */
  tick: number;
}

/**
 * Re-run a read when its inputs change, keeping the last good value while the
 * next one loads (no flash to empty on a filter change).
 */
export function useRead<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e: unknown) => live && setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : "Couldn't load this.", loading: false })),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function scopeRange(days: RangeDays, tick: number) {
  // `tick` is part of the key so a refresh re-anchors "now".
  void tick;
  return rangeFor(days);
}
