/**
 * The ONE place S2b ends a Surfaces draft (reject, expire), on S2a's system
 * path (security round 2, M2):
 *  - expire: the pending review is withdrawn as `system:surfaces`
 *    (`withdrawReviewAsSystem`, a compare-and-set that leaves a review a
 *    person already decided alone);
 *  - reject and expire: the draft is discarded as its recorded submitter
 *    (`discardDraftIfOurs`, only while it is still the submitter's own head —
 *    never a person's later edit).
 * Withdrawal itself is S2a's `withdrawProposalItems`, which uses the same pair.
 */
import { getDb } from "../../db/client.js";
import { withdrawReviewAsSystem } from "../../governance/review-service.js";
import { discardDraftIfOurs } from "./proposal-service.js";

export async function purgeSurfaceDraft(input: {
  nestId: string;
  nodeId: string;
  reviewId: string | null;
  proposalId: string;
  /** Withdraw the still-pending review first (expiry). */
  cancel: boolean;
  /** Discard the draft (default true). */
  discard?: boolean;
  reason?: string;
}): Promise<void> {
  let author: string | null = null;
  if (input.cancel && input.reviewId) {
    const w = await withdrawReviewAsSystem({ nestId: input.nestId, reviewId: input.reviewId, reason: input.reason ?? "expired" }).catch(() => null);
    author = w?.requestedBy ?? null;
  }
  if (input.discard === false) return;
  if (!author && input.reviewId) {
    const r = (await getDb().get("SELECT requested_by FROM review_requests WHERE id = ?", [input.reviewId])) as { requested_by?: string } | undefined;
    author = r?.requested_by ?? null;
  }
  if (!author) {
    const p = (await getDb().get("SELECT persona_email FROM surface_proposals WHERE id = ?", [input.proposalId])) as { persona_email?: string | null } | undefined;
    author = p?.persona_email ?? null;
  }
  if (!author) return;
  try {
    await discardDraftIfOurs(input.nestId, input.nodeId, author);
  } catch {
    /* a person changed it since: theirs now */
  }
}
