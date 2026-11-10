/**
 * Corrections (team chat C6, PO-1199): a member marks a message as a
 * correction of a node, and the server makes the edit proposal — through
 * the path a person's own edit takes: updateNode as the caller (a new draft
 * version on a governed nest, published where their own PATCH would
 * publish), then submitForReview when it drafted. No proposal store of its
 * own; the review queue already accepts exactly this.
 *
 * The draft body is the node's current body with the correction appended as
 * a clearly marked block — "## Correction from #<channel> (<date>), by
 * <name>" quoting the message — unless `replacement` gives the new text, in
 * which case the block only names the source. A `discussed-in` relation
 * (kind corrected) links the thread to the node and makes the action
 * idempotent per (thread, message, node); the thread gets a reply card.
 *
 * Who may: someone who may edit the node (canUserEdit, the context_update
 * rule). A member without that right is told to ask a writer (AC-C6-04). A
 * node the caller can't open is not found; a node with a review pending is
 * locked (409), as it is for any edit.
 */
import { updateNode } from "../nodes/service.js";
import { engineCache } from "../nodes/engine.js";
import { canUserEdit } from "../governance/stewardship-service.js";
import { getPendingReview, submitForReview } from "../governance/review-service.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { callerCanRead, findThreadRelations, recordThreadRelation } from "../nodes/relations.js";
import { getCurrentVersion } from "../governance/version-service.js";
import { addComment, setThreadStatus, syncAnnotationsNode } from "../annotations/service.js";
import { justWritten } from "../mentions/mention-index.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { config } from "../config.js";
import { resolveNestAccess } from "../shared/access.js";
import { channelPostRefusal } from "../channels/channel-service.js";
import { channelNameOf } from "../channels/channel-node.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import type { ActorLabel } from "../channels/actor-label.js";
import type { SourceThread } from "../nodes/service.js";
import { nodeUrl, proposerLabel, quotedMessages, readableDate } from "./format.js";
import { writeStatus, type MemoryNodeRef } from "./remember.js";
import { ASK_A_WRITER, messageIn, readableThread, threadMessages, type MemoryCaller } from "./threads.js";

const MAX_REPLACEMENT = 500_000;
const MAX_NOTE = 2000;

export interface CorrectResult {
  node: MemoryNodeRef;
  source_thread: SourceThread;
  source_message_id: string;
  proposer: ActorLabel;
  reply: { thread_id: string; comment_id: string | null };
  existing: boolean;
}

export interface CorrectCaller extends MemoryCaller {
  client?: ClientMetadata;
  replyClient?: ClientMetadata;
}

export async function correctNode(
  caller: CorrectCaller,
  input: { thread: unknown; message_id?: unknown; node_id?: unknown; replacement?: unknown; note?: unknown },
): Promise<CorrectResult> {
  if (typeof input.message_id !== "string" || !input.message_id.trim()) throw new ValidationError("message_id is required — the message that corrects the node.");
  if (typeof input.node_id !== "string" || !input.node_id.trim()) throw new ValidationError("node_id is required — the node the message corrects.");
  if (input.replacement !== undefined && input.replacement !== null && typeof input.replacement !== "string") throw new ValidationError("replacement must be a string");
  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") throw new ValidationError("note must be a string");
  const replacement = typeof input.replacement === "string" ? input.replacement : null;
  if (replacement !== null && replacement.length > MAX_REPLACEMENT) throw new ValidationError(`replacement is at most ${MAX_REPLACEMENT} characters`);
  const note = String(input.note ?? "").trim().slice(0, MAX_NOTE);
  const nodeId = assertSafeNodeId(input.node_id.trim());
  const { nestId, userId, userEmail } = caller;

  const thread = await readableThread(caller, input.thread);
  const message = messageIn(await threadMessages(thread.id), input.message_id);
  if (nodeId === thread.node_id) throw new ValidationError("The thread's own node can't be corrected from it; correct the node it is about.");

  // The node must exist and be readable by the caller — a miss and a denial
  // look the same (callerCanRead narrows a share grantee to their grants).
  const { storage } = await engineCache.get(nestId);
  let node;
  try {
    node = await storage.readDocument(nodeId);
  } catch {
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }
  if (!(await canOpenNode(nestId, nodeId, userId, userEmail)) || !(await callerCanRead({ nestId, userId, userEmail }, nodeId))) {
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }
  if (config.AUTH_MODE !== "open" && (await resolveNestAccess(nestId, userId)).archived) {
    throw new ForbiddenError("This nest is archived, so it is read-only.");
  }
  if (config.AUTH_MODE !== "open" && !(await canUserEdit(nestId, nodeId, userEmail)).allowed) throw new ForbiddenError(ASK_A_WRITER);
  const refusal = await channelPostRefusal(nestId, thread.node_id, userId, userEmail);
  if (refusal) throw refusal.status === 409 ? new ConflictError(refusal.error) : new ForbiddenError(refusal.error);

  // The declared agent only, as a message row shows it (an API key's label
  // alone is not an agent): the reply attribution carries that rule.
  const proposer = await proposerLabel(userEmail, "replyClient" in caller ? caller.replyClient : caller.client);
  const sourceThread: SourceThread = { node_id: thread.node_id, thread_id: thread.id };

  const earlier = (await findThreadRelations(nestId, { nodeIds: [nodeId], hostNodeIds: [thread.node_id], threadIds: [thread.id] })).find(
    (r) => r.kind === "corrected" && r.message_id === message.id,
  );
  if (earlier) {
    const pending = await getPendingReview(nestId, nodeId);
    return {
      node: {
        id: nodeId,
        title: String(node.frontmatter?.title ?? nodeId),
        type: String(node.frontmatter?.type ?? "document"),
        status: pending ? "pending_review" : writeStatus(node.frontmatter?.status, null),
        version: await getCurrentVersion(nestId, nodeId),
        url: nodeUrl(nestId, nodeId),
        review: pending ? { id: pending.id } : null,
      },
      source_thread: sourceThread,
      source_message_id: message.id,
      proposer,
      reply: { thread_id: thread.id, comment_id: null },
      existing: true,
    };
  }
  if (await getPendingReview(nestId, nodeId)) {
    throw new ConflictError(`${nodeId} already has a change waiting for review. Approve or reject it first, then correct it.`);
  }

  const channel = channelNameOf(thread.node_id);
  const where = channel ? `#${channel}` : `a thread on [[${thread.node_id}]]`;
  const heading = `## Correction from ${where} (${readableDate(message.created_at)}), by ${proposer.label}`;
  const block = replacement === null
    ? `${heading}\n\n${await quotedMessages([message])}\n`
    : `${heading}\n\n_The text above replaces the earlier version; the correction came from ${where}._\n`;
  const content = replacement === null ? `${String(node.body ?? "").replace(/\s+$/, "")}\n\n${block}` : `${replacement.replace(/\s+$/, "")}\n\n${block}`;
  const changeNote = `Correction from ${where} by ${proposer.label}${note ? `: ${note}` : ""}`;

  const updated = await updateNode(
    nestId,
    nodeId,
    { content, changeNote, ...(caller.client ? { client: caller.client } : {}) },
    userEmail,
    { notifyMentions: false },
  );

  let reviewId: string | null = null;
  const landed = String(updated.node.frontmatter?.status ?? "draft");
  if (landed !== "published" && landed !== "approved") {
    const review = await submitForReview({
      nestId,
      nodeId,
      version: updated.version,
      requestedBy: userEmail,
      note: changeNote,
      ...(caller.client ? { client: caller.client } : {}),
    });
    reviewId = review.id;
  }

  await recordThreadRelation({
    nestId,
    nodeId,
    hostNodeId: thread.node_id,
    createdBy: userEmail,
    meta: { thread_id: thread.id, message_id: message.id, kind: "corrected", memory_kind: null, proposer: proposer.label },
  }).catch((err) => console.warn("[correct] relation not recorded", nestId, nodeId, err?.message ?? err));

  const status = writeStatus(landed, reviewId);
  const title = String(updated.node.frontmatter?.title ?? nodeId);
  const replied = await addComment(
    nestId,
    thread.node_id,
    thread.id,
    userEmail,
    `Proposed a correction to [[${nodeId}]] — "${title}"${status === "pending_review" ? " (in review)" : ""}`,
    "replyClient" in caller ? caller.replyClient : caller.client,
  );
  if (thread.status === "resolved") {
    await setThreadStatus(nestId, thread.node_id, thread.id, "resolved", userEmail).catch(() => {});
  }
  await syncAnnotationsNode(nestId, thread.node_id, userEmail);

  return {
    node: {
      id: nodeId,
      title,
      type: String(updated.node.frontmatter?.type ?? "document"),
      status,
      version: updated.version,
      url: nodeUrl(nestId, nodeId),
      review: reviewId ? { id: reviewId } : null,
    },
    source_thread: sourceThread,
    source_message_id: message.id,
    proposer,
    reply: { thread_id: thread.id, comment_id: justWritten(replied, userEmail) },
    existing: false,
  };
}

export function correctText(r: CorrectResult): string {
  if (r.existing) return `That message was already recorded as a correction of "${r.node.title}" (${r.node.id}, v${r.node.version}, ${r.node.status}). Nothing new was created.`;
  const where =
    r.node.status === "pending_review"
      ? `v${r.node.version} is a draft in the review queue (review ${r.node.review?.id}); a reviewer approves it.`
      : `v${r.node.version} is ${r.node.status}.`;
  return `Proposed a correction to "${r.node.title}" (${r.node.id}) by ${r.proposer.label}: ${where} The thread has a reply linking it.`;
}
