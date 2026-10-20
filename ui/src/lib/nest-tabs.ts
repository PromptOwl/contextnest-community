/**
 * NestView's own tab slugs — the whitelist for ?tab= — and their breadcrumb
 * labels. Some are permission or feature gated inside NestView, which falls
 * back to overview when one isn't shown (e.g. `stream` while the experimental
 * document stream is off).
 */
export const NEST_TAB_LABELS: Record<string, string> = {
  overview: "Overview",
  documents: "Documents",
  review: "Review queue",
  "external-edits": "External edits",
  stewards: "Stewards",
  collaborators: "Collaborators",
  fields: "Fields",
  stream: "Stream",
};

export const NEST_TABS: string[] = Object.keys(NEST_TAB_LABELS);

/** The tab a ?tab= value opens, or undefined for an unknown slug. */
export function nestTabFromParam(raw: string | null | undefined): string | undefined {
  return raw && NEST_TABS.includes(raw) ? raw : undefined;
}
