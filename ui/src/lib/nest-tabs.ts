/**
 * NestView's own tab slugs — the whitelist for ?tab= — and their breadcrumb
 * labels. Some are permission or feature gated inside NestView, which falls
 * back to documents when one isn't shown (e.g. `stream` while the experimental
 * document stream is off).
 *
 * Overview folded into Documents and Stewards into Collaborators, so neither
 * has a tab of its own; the old slugs live on as aliases (below).
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

/** Slugs that used to be tabs of their own. Old links and bookmarks keep working. */
const TAB_ALIASES: Record<string, string> = {
  overview: "documents",
  stewards: "collaborators",
  // Fields moved into Settings.
  fields: "settings",
};

/** The tab a ?tab= value opens, or undefined for an unknown slug. */
export function nestTabFromParam(raw: string | null | undefined): string | undefined {
  const slug = raw ? (TAB_ALIASES[raw] ?? raw) : raw;
  return slug && NEST_TABS.includes(slug) ? slug : undefined;
}
