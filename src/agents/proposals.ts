/**
 * A proposal Hootie made in a conversation, filed the way this server already
 * files a write that waits on a person (C7, PO-1198): a draft authored by
 * `hootie`, never published (`alwaysDraft`), submitted to the review queue —
 * the metacognition agent's own path (src/metacognition/tools.ts
 * proposeNewDraft / proposeEditDraft), with the same guards for an edit (no
 * pending review, no one else's unsealed draft, head checked inside the write
 * lock). The card in the thread names the review; a writer decides it with
 * the ordinary approve / reject (`POST …/nodes/:id/approve`, MCP
 * `context_approve`), and that approval is the approver's own publish.
 *
 * No table: the review request IS the proposal's record, and the card's
 * status is read from it (channel-service `proposalStatuses`).
 */
import { getDb } from "../db/client.js";
import { createNode, updateNode, type SourceThread } from "../nodes/service.js";
import { getPendingReview, submitForReview } from "../governance/review-service.js";
import { getCurrentVersion, hasUnsealedDraft } from "../governance/version-service.js";
import { AppError } from "../shared/errors.js";
import { effectiveHootieBrand } from "../hootie/brand.js";
import { HOOTIE_HANDLE } from "./reserved.js";
import type { PendingProposal, ProposalKind } from "./proposal-tools.js";

/** The card's `proposal` as stored and as the timeline shows it. */
export interface ProposalView {
  kind: ProposalKind;
  /** The draft's node (null when filing failed before a node existed). */
  node_id: string | null;
  version: number | null;
  /** The review request to approve or reject; null when filing failed. */
  review_id: string | null;
  title: string;
  /** Model text: what was proposed. */
  preview: string;
  /** pending | approved | rejected | cancelled (from the review request;
   *  enriched at read time), failed (could not be filed), unfiled (not
   *  posted, so not filed). */
  status: "pending" | "approved" | "rejected" | "cancelled" | "failed" | "unfiled";
  /** Why it could not be filed (fixed copy). */
  reason: string | null;
  /** The card message, once posted. */
  message_id: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
}

/** A node id as the server mints them (hootie/routes.ts isNodeIdShaped). */
const NODE_ID_SHAPE = /^nodes(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

export async function fileProposal(params: {
  nestId: string;
  /** The channel node the thread is on. */
  nodeId: string;
  threadId: string;
  channel: string | null;
  askedBy: string;
  baseUrl: string;
  pending: PendingProposal;
}): Promise<ProposalView> {
  const { nestId, nodeId, threadId, askedBy, baseUrl, pending } = params;
  const brand = effectiveHootieBrand().name;
  const where = params.channel ? `#${params.channel}` : nodeId;
  const note = `Proposed by ${brand} in ${where} for ${askedBy}.`;
  const sourceThread: SourceThread = { node_id: nodeId, thread_id: threadId };
  const base = { kind: pending.kind, title: String(pending.target.title ?? ""), preview: pending.preview, message_id: null, reason: null } as const;
  const failed = (reason: string, node_id: string | null = null): ProposalView => ({ ...base, node_id, version: null, review_id: null, status: "failed", reason });
  try {
    if (pending.kind === "create_node") {
      const type = pending.target.type === "task" ? "task" : "document";
      const folder = typeof pending.target.folder === "string" && pending.target.folder ? pending.target.folder : undefined;
      const content = `${note}\n\n${String(pending.target.content ?? "")}`;
      const created = await createNode(
        nestId,
        { title: base.title, content, type, ...(folder ? { folder } : {}), sourceThread },
        HOOTIE_HANDLE,
        { alwaysDraft: true, creatorReviews: false, notifyMentions: false },
      );
      const review = await submitForReview({ nestId, nodeId: created.node.id, version: created.version, requestedBy: HOOTIE_HANDLE, note, baseUrl });
      return { ...base, node_id: created.node.id, version: created.version, review_id: review.id, status: "pending" };
    }
    const target = String(pending.target.node_id ?? "");
    if (!NODE_ID_SHAPE.test(target)) return failed("not a document.");
    // Only a document whose working copy IS its approved text (as the
    // metacognition agent's propose_edit): a pending review or someone's
    // unsaved draft is a person's work, and a proposal over it would replace it.
    if (await getPendingReview(nestId, target)) return failed("that document already has a change waiting for review.", target);
    const head = await getCurrentVersion(nestId, target);
    if (await hasUnsealedDraft(nestId, target)) return failed("someone is working on a draft of that document.", target);
    const res = await updateNode(
      nestId,
      target,
      { append: `\n\n${String(pending.target.append ?? "")}\n\n_${note}_`, changeNote: note },
      HOOTIE_HANDLE,
      { alwaysDraft: true, notifyMentions: false, expectHead: head },
    );
    const review = await submitForReview({ nestId, nodeId: target, version: res.version, requestedBy: HOOTIE_HANDLE, note, baseUrl });
    return { ...base, node_id: target, version: res.version, review_id: review.id, status: "pending" };
  } catch (err) {
    // Fixed copy back to the thread: the engine's wording can carry what the
    // asker asked about, and the card is model text already.
    console.error("[ask-nest] proposal could not be filed", nestId, threadId, err instanceof Error ? err.name : "error");
    return failed(err instanceof AppError && err.statusCode < 500 ? "it could not be filed as a draft (a conflict or a rule refused it)." : "it could not be filed (server error).");
  }
}

/** The live status of each review a card names, in one query — scoped to
 *  the nest the cards are read in, so a review id can never be looked up
 *  across nests whatever a stored card says. */
export async function proposalStatuses(nestId: string, reviewIds: string[]): Promise<Map<string, { status: string; decided_by: string | null; decided_at: string | null }>> {
  const out = new Map<string, { status: string; decided_by: string | null; decided_at: string | null }>();
  const ids = [...new Set(reviewIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return out;
  const rows = (await getDb().all(
    `SELECT id, status, resolved_by, resolved_at FROM review_requests WHERE nest_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
    [nestId, ...ids],
  )) as Array<{ id: string; status: string; resolved_by: string | null; resolved_at: string | null }>;
  for (const r of rows) out.set(r.id, { status: r.status, decided_by: r.resolved_by, decided_at: r.resolved_at });
  return out;
}
