/**
 * App-level navigation for pages. App owns the view state; pages call these
 * instead of taking one callback prop each, so App never needs to know a
 * page's props — which is what lets a page register itself from its folder.
 */
import { createContext, useContext } from "react";

export interface AppNav {
  openNest: (
    nestId: string,
    name: string,
    isOwner: boolean,
    isAnonOwned: boolean,
    isArchived?: boolean,
  ) => void;
  /** Open a document straight from a queue row — `thread` focuses that
   *  comment thread (the ?thread= deep link). */
  openReview: (
    nestId: string,
    nestName: string,
    nodeId: string,
    opts?: { thread?: string },
  ) => void;
  /** Keys are minted and rotated on their own page, never inline. */
  manageKeys: () => void;
  /** Return to the page this one was opened from (the header bell), if any. */
  goBack?: () => void;
}

const AppNavContext = createContext<AppNav | null>(null);

export const AppNavProvider = AppNavContext.Provider;

export function useAppNav(): AppNav {
  const nav = useContext(AppNavContext);
  if (!nav) throw new Error("useAppNav: no AppNavProvider above this page");
  return nav;
}
