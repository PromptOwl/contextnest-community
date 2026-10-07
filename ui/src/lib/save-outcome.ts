/**
 * What the editor's save will do, so its buttons can say so. Mirrors the
 * server's single gate (`autoPublishReason` in src/nodes/service.ts); the
 * server stays the authority, this only picks the label.
 *
 *   publish — the edit goes live (Publish)
 *   draft   — it lands as a draft that needs review (Save draft / Submit)
 *   pending — the author is revising their own open submission (auto-saved)
 */
export type SaveOutcome = "publish" | "draft" | "pending";

export function saveOutcome(s: {
  isNew: boolean;
  isOwnPendingReview: boolean;
  stewardshipEnabled: boolean;
  prime: boolean;
  primeOnlyReview: boolean;
  creatorIsReviewer: boolean;
  allowSelfApprove: boolean;
  /** Nest owner or admin — the roles self-approve applies to. */
  ownerOrAdmin: boolean;
  /** A `task` node (before this edit): board work skips review. */
  isTask?: boolean;
}): SaveOutcome {
  if (s.isOwnPendingReview) return "pending";
  if (!s.stewardshipEnabled) return "publish";
  // Prime is checked before every bypass: a prime document always needs review.
  if (s.prime) return "draft";
  if (s.isTask) return "publish";
  if (s.isNew && s.creatorIsReviewer) return "publish";
  if (s.primeOnlyReview) return "publish";
  return s.allowSelfApprove && s.ownerOrAdmin ? "publish" : "draft";
}
