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
  /** Open a document straight from a queue row. */
  openReview: (nestId: string, nestName: string, nodeId: string) => void;
  /** Keys are minted and rotated on their own page, never inline. */
  manageKeys: () => void;
  /** Back to the dashboard — what the account pages' back arrows do. */
  openDashboard: () => void;
}

const AppNavContext = createContext<AppNav | null>(null);

export const AppNavProvider = AppNavContext.Provider;

export function useAppNav(): AppNav {
  const nav = useContext(AppNavContext);
  if (!nav) throw new Error("useAppNav: no AppNavProvider above this page");
  return nav;
}
