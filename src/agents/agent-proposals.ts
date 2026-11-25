/**
 * An agent's approve card (chat as orchestration, epic
 * recipes-and-the-central-harness): the gate an agent puts in front of its
 * own work, in the thread it was woken in.
 *
 * Reuses what C7 already has for "a write that waits on a person" (see
 * proposals.ts): the plan is filed as a draft, never published
 * (`alwaysDraft`), and submitted to the ordinary review queue — here under
 * the CALLER's own login (the agent's key), not Hootie's. The card is an
 * ordinary message in the thread carrying the server-only `proposal` mark
 * (agents/reserved.ts SERVER_CLIENT_KEYS, so no caller can forge one through
 * context_comment), with `proposed_by` naming the agent handle. The timeline
 * reads its live status from the review request (channel-service
 * proposalStatuses), a writer decides it with the ordinary approve / reject
 * (REST `…/nodes/:id/approve`, MCP `context_approve`), and the decision wakes
 * the agent (stream/agent-wake.ts wakeOnProposalDecided).
 *
 * No table: the review request is the record, the draft's
 * `metadata.source_thread` links it to the thread, and the card names both.
 *
 * Guards: members only and a channel thread the caller can read (the handoff
 * rule, handoffs.ts readableChannelThread + channelPostRefusal), or a thread
 * of a conversation the caller is a member of (an agent woken by a DM); the caller
 * must be able to create in the nest (a draft under review pages reviewers,
 * so a reader can't make one); bounded title and plan; the card's text is
 * model text and goes through inertAnswer like Hootie's cards.
 */
import { randomBytes } from "node:crypto";
import { getDb } from "../db/client.js";
import { addComment, syncAnnotationsNode } from "../annotations/service.js";
import { createNode } from "../nodes/service.js";
import { cancelReview, submitForReview } from "../governance/review-service.js";
import { canCreateInNest } from "../governance/stewardship-service.js";
import { serializeClient, type ClientMetadata } from "../shared/client-metadata.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { channelPostRefusal } from "../channels/channel-service.js";
import { callerSafeClient, normHandle } from "../channels/message-meta.js";
import { justWritten } from "../mentions/mention-index.js";
import { inertAnswer } from "../hootie/inert.js";
import { readableChannelThread, type HandoffCaller } from "./handoffs.js";
import { isContainerMember, isConversationId } from "../chat/containers.js";
import { isNestMember } from "../channels/channel-service.js";
import { isReservedHandle } from "./reserved.js";
import { agentPrincipalOf } from "./principals.js";

export const MAX_PROPOSAL_TITLE = 200;
export const MAX_PROPOSAL_CONTENT = 20_000;
const PREVIEW_MAX = 1200;
const FOLDER_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;
/** Where a plan lands when the agent names no folder. */
export const DEFAULT_PROPOSAL_FOLDER = "plans";

export interface AgentProposalView {
  kind: "create_node";
  node_id: string;
  version: number;
  review_id: string;
  title: string;
  preview: string;
  status: "pending";
  reason: null;
  /** The card message. */
  message_id: string;
  /** The agent handle that filed it: the one the decision wakes. Null when
   *  the caller is not proven to be that agent (provenHandle): then it wakes
   *  nobody. */
  proposed_by: string | null;
  thread_id: string;
  /** The channel's name, or null in a conversation. */
  channel: string | null;
  /** The conversation (C2) the card is in, or null in a channel. */
  conversation: string | null;
}

/**
 * The thread a card may go in: a channel thread the caller can read (the
 * handoff rule), or a thread of a direct or group conversation the caller is
 * a member of — an agent woken by a DM files its card where it was asked.
 * NotFound for anything else, one answer for "no such thread" and "not yours".
 */
async function cardThread(caller: HandoffCaller, threadId: string): Promise<{ nodeId: string; conversation: boolean }> {
  const row = (await getDb().get("SELECT node_id FROM annotation_threads WHERE id = ? AND nest_id = ?", [threadId, caller.nestId])) as
    | { node_id: string }
    | undefined;
  if (row && isConversationId(row.node_id)) {
    if (!(await isNestMember(caller.nestId, caller.userId)) || !(await isContainerMember(caller.nestId, row.node_id, caller.userId))) {
      throw new NotFoundError("Thread not found");
    }
    return { nodeId: row.node_id, conversation: true };
  }
  return { ...(await readableChannelThread(caller, threadId)), conversation: false };
}

function text(raw: unknown, name: string, max: number): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ValidationError(`${name} is required`);
  const v = raw.trim();
  if (v.length > max) throw new ValidationError(`${name} is at most ${max.toLocaleString("en-US")} characters`);
  return v;
}

function previewOf(content: string): string {
  const flat = content.replace(/\r/g, "").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

/** The handle a caller's attribution names, if it is one an agent may have. */
export function proposerHandle(client: ClientMetadata | undefined): string | null {
  const c = (client ?? {}) as Record<string, unknown>;
  const h = normHandle(c.agent) || normHandle(c.key_label);
  return h && !isReservedHandle(h) && /^[a-z0-9][a-z0-9._-]{0,62}$/.test(h) ? h : null;
}

/**
 * The handle the decision on this card wakes. A declared `client.agent` and a
 * key's label are what the caller SAYS it is (anyone can label their own key),
 * and the wake is a signed "a person approved your plan" that a runner acts
 * on, so saying it is not enough: the handle counts only when this call came
 * on that agent's own hired key, or from the login that set up its webhook.
 * Anything else files the card and wakes nobody.
 */
export async function provenHandle(
  caller: Pick<HandoffCaller, "nestId" | "userEmail" | "apiKeyId">,
  client: ClientMetadata | undefined,
): Promise<string | null> {
  const handle = proposerHandle(client);
  if (!handle) return null;
  const db = getDb();
  if (caller.apiKeyId) {
    const hired = await db.get("SELECT 1 AS ok FROM hired_agents WHERE nest_id = ? AND kind = 'key' AND handle = ? AND ref = ?", [caller.nestId, handle, caller.apiKeyId]);
    if (hired) return handle;
  }
  const hook = await db.get("SELECT 1 AS ok FROM agent_webhooks WHERE nest_id = ? AND handle = ? AND LOWER(created_by) = LOWER(?)", [caller.nestId, handle, caller.userEmail]);
  return hook ? handle : null;
}

/** Tests only: runs after the review is filed and before its card is written. */
let beforeCard: ((nodeId: string) => Promise<void>) | null = null;
export function _setBeforeCard(fn: ((nodeId: string) => Promise<void>) | null): void {
  beforeCard = fn;
}

export async function proposeInThread(
  caller: HandoffCaller,
  rawThreadId: unknown,
  input: { title: unknown; content: unknown; folder?: unknown },
): Promise<{ proposal: AgentProposalView }> {
  const threadId = typeof rawThreadId === "string" ? rawThreadId.trim() : "";
  if (!threadId) throw new ValidationError("thread is required");
  let title = text(input.title, "title", MAX_PROPOSAL_TITLE);
  const content = text(input.content, "content", MAX_PROPOSAL_CONTENT);
  let folder = DEFAULT_PROPOSAL_FOLDER;
  if (input.folder !== undefined && input.folder !== null && input.folder !== "") {
    if (typeof input.folder !== "string" || input.folder.length > 80 || !FOLDER_RE.test(input.folder)) {
      throw new ValidationError('folder is a path under nodes/ in lowercase words and dashes, e.g. "plans" or "features/plans"');
    }
    folder = input.folder;
  }

  // NotFound for a thread the caller can't read, a non-member, a document thread.
  const { nodeId, conversation } = await cardThread(caller, threadId);
  const refusal = await channelPostRefusal(caller.nestId, nodeId, caller.userId, caller.userEmail);
  if (refusal) throw refusal.status === 409 ? new ConflictError(refusal.error) : new ForbiddenError(refusal.error);
  if (!(await canCreateInNest(caller.nestId, caller.userEmail))) {
    throw new ForbiddenError("You can read this nest but not create in it, so you can't file an approve card here.");
  }

  const client = callerSafeClient(caller.client);
  // A hired agent's own identity names the handle the decision wakes — a
  // declared label can't point the wake at another agent. Anyone else must
  // prove the handle (provenHandle).
  const principal = await agentPrincipalOf(caller.userId);
  const proposedBy = principal ? principal.handle : await provenHandle(caller, client);
  const channel = conversation ? null : (nodeId.split("/").pop() ?? null);
  const note = `Proposed${proposedBy ? ` by @${proposedBy}` : ""} in ${channel ? `#${channel}` : "a conversation"} for approval.`;

  // The plan: a draft under review, linked to the thread it came from.
  // An agent re-plans under the same title across sessions: a taken one gets
  // a short suffix instead of refusing the card, so context_approve /
  // context_reject (which find a document by title) still name exactly one.
  const opts = { alwaysDraft: true, creatorReviews: false, notifyMentions: false };
  const make = (t: string) =>
    createNode(
      caller.nestId,
      { title: t, content, type: "document", folder, sourceThread: { node_id: nodeId, thread_id: threadId }, ...(client ? { client } : {}) },
      caller.userEmail,
      opts,
    );
  let created: Awaited<ReturnType<typeof createNode>>;
  try {
    created = await make(title);
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
    title = `${title} (${randomBytes(3).toString("hex")})`;
    created = await make(title);
  }
  const review = await submitForReview({
    nestId: caller.nestId,
    nodeId: created.node.id,
    version: created.version,
    requestedBy: caller.userEmail,
    note,
    baseUrl: caller.baseUrl ?? "",
  });

  const preview = previewOf(content);
  let proposal: AgentProposalView;
  try {
  await beforeCard?.(created.node.id);
  // The card: model text, made inert like Hootie's (no live links, escaped).
  const body = inertAnswer(`Approval needed — ${title}\n\n${preview}`);
  const thread = await addComment(caller.nestId, nodeId, threadId, caller.userEmail, body, client);
  const messageId = justWritten(thread, caller.userEmail);
  if (!messageId) throw new Error("proposal card not written");
  proposal = {
    kind: "create_node",
    node_id: created.node.id,
    version: created.version,
    review_id: review.id,
    title,
    preview,
    status: "pending",
    reason: null,
    message_id: messageId,
    proposed_by: proposedBy,
    thread_id: threadId,
    channel,
    conversation: conversation ? nodeId : null,
  };
  // The server-only mark, written after the message exists (the handoff path).
  await getDb().run("UPDATE annotation_comments SET client_json = ? WHERE id = ?", [
    serializeClient({ ...(client ?? {}), proposal } as unknown as ClientMetadata),
    messageId,
  ]);
  } catch (err) {
    // No card, so nobody can be asked from the thread: take the review back
    // out of the queue rather than leave one that wakes nobody. The plan
    // stays its author's draft.
    await cancelReview({ nestId: caller.nestId, nodeId: created.node.id, cancelledBy: caller.userEmail }).catch((e) =>
      console.error("[agent-proposals] could not withdraw a review without a card", caller.nestId, created.node.id, e),
    );
    throw err;
  }
  // The review was in the queue before its card existed. A decision that fell
  // in between found no card and woke nobody; send its wake now (once: the
  // delivery is keyed on the review and the handle).
  await wakeIfAlreadyDecided(caller.nestId, created.node.id, review.id);
  await syncAnnotationsNode(caller.nestId, nodeId, caller.userEmail).catch(() => {});
  return { proposal };
}

async function wakeIfAlreadyDecided(nestId: string, nodeId: string, reviewId: string): Promise<void> {
  try {
    const row = (await getDb().get("SELECT status, resolved_by FROM review_requests WHERE id = ? AND nest_id = ?", [reviewId, nestId])) as
      | { status: string; resolved_by: string | null }
      | undefined;
    if (!row || (row.status !== "approved" && row.status !== "rejected") || !row.resolved_by) return;
    const { wakeOnProposalDecided } = await import("../stream/agent-wake.js");
    await wakeOnProposalDecided({ nestId, nodeId, reviewId, status: row.status, decidedBy: row.resolved_by });
  } catch (err) {
    console.error("[agent-proposals] late decision wake failed", nestId, reviewId, err);
  }
}

export function proposalCardText(p: AgentProposalView): string {
  return (
    `Approve card ${p.message_id} in ${p.channel ? `#${p.channel}` : "the conversation"} thread ${p.thread_id}: "${p.title}" — pending review ${p.review_id} of ${p.node_id} v${p.version}. ` +
    `A reviewer approves it with context_approve { title: "${p.title}" } or rejects it with context_reject (REST: POST …/nodes/${p.node_id}/approve | /reject); ` +
    (p.proposed_by ? `the decision wakes @${p.proposed_by}.` : "this call did not come from an agent's own key, so the decision wakes nobody.")
  );
}
