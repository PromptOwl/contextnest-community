/**
 * What a document's lifecycle status means and what happens next — the
 * tooltip on LifecycleStatusBadge. A pill alone ("Pending Review") doesn't
 * say who acts or what readers see meanwhile, which is what users kept
 * asking after Submit.
 *
 * Mirrors decideDisplayStatus (src/governance/version-service.ts): a draft
 * or pending doc keeps serving its last approved version, if it has one.
 */
export interface LifecycleHintContext {
  /** Submitter of the open review (GET /nodes/:id `pendingReviewBy`). */
  submittedBy?: string | null;
  /** Nest has stewardship on — drafts go through review to go live. */
  stewardship?: boolean;
}

const STILL_SERVING = "Readers and AI keep seeing the last approved version, if there is one.";

export function lifecycleStatusHint(status: string, ctx: LifecycleHintContext = {}): string {
  switch (status) {
    case "draft":
      return ctx.stewardship
        ? `Draft — not approved yet. Submit for review to send it to a steward. ${STILL_SERVING}`
        : `Draft — not published yet. ${STILL_SERVING}`;
    case "pending_review":
      return `Submitted for review${ctx.submittedBy ? ` by ${ctx.submittedBy}` : ""} — waiting for a steward to approve or reject it. ${STILL_SERVING}`;
    case "approved":
      return "Approved by a steward. This version is what readers and AI see.";
    case "published":
      return "Published. This version is what readers and AI see.";
    case "rejected":
      return "Rejected by a steward. Check the review notes, edit, and submit again.";
    case "external_edit_pending":
      return "Changed outside the app (CLI, MCP or sync). Review the incoming edit to accept or discard it.";
    default:
      return "";
  }
}
