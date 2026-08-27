import { useCallback, useEffect, useRef } from "react";
import { ROVING_KEYS, nextFocusIndex, tabStopIndex } from "./roving-focus";

/**
 * Make a group of controls behave as one tab stop, with arrow keys moving
 * between its items (see roving-focus.ts for why).
 *
 * Spread the returned props on the group's container. Items are found by
 * query, so nothing has to be threaded through each button — which matters
 * for a toolbar whose contents change with the selection and the enabled
 * feature flags.
 */
export function useRovingFocus<T extends HTMLElement>(
  selector = "button:not([disabled])",
) {
  const ref = useRef<T>(null);

  const items = useCallback(
    () => Array.from(ref.current?.querySelectorAll<HTMLElement>(selector) ?? []),
    [selector],
  );

  // No dependency array: buttons appear, disable and re-render as the
  // selection moves, and each one arrives with the browser's default
  // tabIndex. Re-stamping after every render is a walk over ~20 nodes.
  useEffect(() => {
    const list = items();
    if (!list.length) return;
    const stop = tabStopIndex(
      list.findIndex((el) => el === document.activeElement),
      list.findIndex((el) => el.getAttribute("aria-checked") === "true"),
    );
    for (const [i, el] of list.entries()) el.tabIndex = i === stop ? 0 : -1;
  });

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!ROVING_KEYS.includes(e.key)) return;
      const list = items();
      const next = nextFocusIndex(
        e.key,
        list.indexOf(document.activeElement as HTMLElement),
        list.length,
      );
      if (next === null) return;
      // Only once a move is certain: the editor binds its own arrow-key
      // handling, and a toolbar that swallowed every arrow press would break
      // it for anyone who tabbed past.
      e.preventDefault();
      list[next]!.focus();
    },
    [items],
  );

  return { ref, onKeyDown };
}
