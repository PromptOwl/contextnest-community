/**
 * NestView's own tab slugs — the whitelist for ?tab= — and their breadcrumb
 * labels. Some are permission or feature gated inside NestView, which falls
 * back to Documents when one isn't shown (e.g. `stream` while the experimental
 * document stream is off). `fields` has no tab of its own: the header's ⋯
 * menu opens it, and ?tab=fields still does (po-1213).
 */
export const NEST_TAB_LABELS: Record<string, string> = {
  documents: "Documents",
  instructions: "Instructions",
  review: "Review queue",
  "external-edits": "External edits",
  stewards: "Stewards",
  collaborators: "Collaborators",
  fields: "Fields",
  stream: "Stream",
};

export const NEST_TABS: string[] = Object.keys(NEST_TAB_LABELS);

/** Where a nest opens. Overview merged into Documents (po-1213). */
export const DEFAULT_NEST_TAB = "documents";

/** Retired slugs that old links still carry → the tab that replaced them. */
const RETIRED_TABS: Record<string, string> = { overview: DEFAULT_NEST_TAB };

/** The tab a ?tab= value opens, or undefined for an unknown slug. */
export function nestTabFromParam(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (RETIRED_TABS[raw]) return RETIRED_TABS[raw];
  return NEST_TABS.includes(raw) ? raw : undefined;
}
