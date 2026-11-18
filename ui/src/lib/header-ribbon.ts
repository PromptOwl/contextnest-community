/**
 * The header ribbon: the places a reviewer needs from any screen.
 *
 * My Work and My Drafts span every nest, but they used to live only in the
 * sidebar rail and a small bell, so someone working inside one nest never saw
 * what was waiting in the others. They sit in the header now, with the same
 * counts as the rail, and they are always there.
 *
 * Only workspace-wide items live here, so the bar is the same on every screen.
 * Instructions is a tab of its nest, and Browse is the nest sidebar.
 *
 * Kept free of React so what shows, what is highlighted and where each item
 * goes can be tested without a browser.
 */

export type RibbonKey = "my-work" | "my-drafts";

/** The slice of the app's current view the ribbon reads. */
export interface RibbonView {
  page: string;
  /** A dashboard page id, or one of a nest's own tabs. */
  tab?: string;
  /** Present on every nest-scoped view (nest, document, board, graph, …). */
  nestId?: string;
  /** Public reader mode shows a stripped-down page with no workspace chrome. */
  readerMode?: boolean;
}

export interface RibbonItem {
  key: RibbonKey;
  label: string;
  /** Shown as a pill when above zero. */
  count?: number;
  /** How many of `count` are urgent. Above zero, the pill turns red. */
  urgent?: number;
  active: boolean;
}

export interface RibbonInput {
  view: RibbonView;
  counts: { work: number; drafts: number; urgent?: number };
  /** Reached the nest through a share on one document or folder. They have no
   *  Instructions tab, so offering it would only bounce them to the overview. */
  grantOnly?: boolean;
}

export function ribbonItems({ view, counts, grantOnly }: RibbonInput): RibbonItem[] {
  if (view.readerMode) return [];
  const onDashboard = view.page === "dashboard";
  const items: RibbonItem[] = [
    {
      key: "my-work",
      label: "My Work",
      count: counts.work,
      urgent: counts.urgent ?? 0,
      active: onDashboard && view.tab === "my-work",
    },
    {
      key: "my-drafts",
      label: "My Drafts",
      count: counts.drafts,
      active: onDashboard && view.tab === "my-drafts",
    },
  ];
  return items;
}

/** Where an item goes. */
export type RibbonTarget = { page: "dashboard"; tab: "my-work" | "my-drafts" };

export function ribbonTarget(key: RibbonKey): RibbonTarget {
  switch (key) {
    case "my-work":
      return { page: "dashboard", tab: "my-work" };
    case "my-drafts":
      return { page: "dashboard", tab: "my-drafts" };
  }
}
