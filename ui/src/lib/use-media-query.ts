import { useCallback, useMemo, useSyncExternalStore } from "react";

/** Live `window.matchMedia(query).matches`; false where there is no window. */
export function useMediaQuery(query: string): boolean {
  // One MediaQueryList per query, shared by subscribe and the snapshot.
  const mql = useMemo(
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query) : null),
    [query],
  );
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!mql) return () => {};
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [mql],
  );
  return useSyncExternalStore(subscribe, () => mql?.matches ?? false, () => false);
}
