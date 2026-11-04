/**
 * Hootie's status lines (PRD §3.5): what the panel shows while Hootie looks.
 *
 * Every line is a fixed server template, and none depends on anything the
 * caller can't read: the same call gives the same bytes whatever exists in
 * the nest (a line that changed with hidden content would be an existence
 * oracle — security r1 F1). Node names in lines come from the turn's
 * allowlist — titles the caller has already been given.
 */

export const STATUS = {
  listBoards: "Read the boards",
  board: (name: string) => `Read board “${name}”`,
  node: (title: string) => `Read “${title}”`,
  listNodes: "Listed documents",
  reviewQueue: "Read the review queue · items you can review",
  fields: "Read the custom fields",
  relations: (title: string) => `Read the relations of “${title}”`,
  thinFirstPass: "First pass was thin. Searched again more broadly",
} as const;
