/**
 * The Collaborators tab's Reviewer switch (CU-wdqcq04wnr): which nest-scope
 * steward row, if any, backs it for one person. Tag- and document-scope rows
 * don't count — the switch means "reviews the whole nest".
 */
export type NestReviewerState =
  | { kind: "none" }
  | { kind: "reviewer"; stewardId: string }
  /** A different nest-wide steward role — changed on the Stewards tab, not by
   *  the switch, so flipping it never silently drops that role. */
  | { kind: "other"; role: string };

export function nestReviewerState(
  stewards: Array<{ id: string; userEmail: string; role: string; scope: string }>,
  email: string,
): NestReviewerState {
  const me = email.trim().toLowerCase();
  const rows = stewards.filter((s) => s.scope === "nest" && s.userEmail.toLowerCase() === me);
  const reviewer = rows.find((s) => s.role === "reviewer");
  if (reviewer) return { kind: "reviewer", stewardId: reviewer.id };
  return rows[0] ? { kind: "other", role: rows[0].role } : { kind: "none" };
}
