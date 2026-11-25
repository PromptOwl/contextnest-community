/**
 * NestView's own tab slugs — the whitelist for ?tab= — and their breadcrumb
 * labels. Some are permission or feature gated inside NestView, which falls
 * back to Documents when one isn't shown (e.g. `stream` while the experimental
 * document stream is off). Fields live in Settings; the header's ⋯ menu also
 * opens them as a dialog over Documents (po-1213).
 */
export const NEST_TAB_LABELS: Record<string, string> = {
  documents: "Documents",
  instructions: "Instructions",
  review: "Review queue",
  "external-edits": "External edits",
  collaborators: "Collaborators",
  settings: "Settings",
  activity: "Activity",
  stream: "Stream",
};

export const NEST_TABS: string[] = Object.keys(NEST_TAB_LABELS);

/** Where a nest opens. Overview merged into Documents (po-1213). */
export const DEFAULT_NEST_TAB = "documents";

/** Retired slugs that old links still carry → the tab that replaced them.
 *  Overview merged into Documents (po-1213), Stewards into Collaborators
 *  (po-1428); Fields moved into Settings. */
const RETIRED_TABS: Record<string, string> = {
  overview: DEFAULT_NEST_TAB,
  stewards: "collaborators",
  fields: "settings",
};

/** The tab a ?tab= value opens, or undefined for an unknown slug. */
export function nestTabFromParam(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (RETIRED_TABS[raw]) return RETIRED_TABS[raw];
  return NEST_TABS.includes(raw) ? raw : undefined;
}

/**
 * What a tab value opens. A ?tab=fields link resolves to Settings first
 * (nestTabFromParam); a tab change to `fields` opens the Fields dialog over
 * Documents (po-1213).
 */
export function nestTabOpening(tab: string | null | undefined): { tab: string; fieldsOpen: boolean } {
  if (tab === "fields") return { tab: DEFAULT_NEST_TAB, fieldsOpen: true };
  return { tab: tab || DEFAULT_NEST_TAB, fieldsOpen: false };
}

export type NestViewMenuKey = "grid" | "list" | "fields" | "reader";

/**
 * The "how this page shows" items at the top of the nest header's ⋯ menu
 * (po-1213): the list/grid switch (Documents only — it lays out nothing
 * else), Fields (not for a share-grant-only viewer) and Reader mode (for
 * whoever manages it, once the nest has loaded and while it isn't archived).
 * NestView adds the icon and the action for each key.
 */
export function nestViewMenuItems(o: {
  activeTab: string;
  viewMode: "list" | "cards";
  grantOnly: boolean;
  canManageReaderMode: boolean;
  nestArchived: boolean;
  initialLoad: boolean;
  readerModeEnabled: boolean;
}): Array<{ key: NestViewMenuKey; label: string; testId: string }> {
  const items: Array<{ key: NestViewMenuKey; label: string; testId: string }> = [];
  if (o.activeTab === DEFAULT_NEST_TAB)
    items.push(
      o.viewMode === "list"
        ? { key: "grid", label: "Show as grid", testId: "nest-view-grid" }
        : { key: "list", label: "Show as list", testId: "nest-view-list" },
    );
  if (!o.grantOnly) items.push({ key: "fields", label: "Fields", testId: "nest-open-fields" });
  if (o.canManageReaderMode && !o.nestArchived && !o.initialLoad)
    items.push({
      key: "reader",
      label: o.readerModeEnabled ? "Reader mode: On" : "Reader mode: Off",
      testId: "nest-reader-mode",
    });
  return items;
}
