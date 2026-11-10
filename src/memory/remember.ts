/**
 * "Remember this" (team chat C6, PO-1199): a message, or a whole thread,
 * becomes a proposed node — through the path a person's own draft takes.
 *
 *   createNode as the caller → on a governed nest that is a draft, which is
 *   then submitted for review (the review queue, requested by the caller);
 *   on an ungoverned or self-approve nest it publishes, exactly as their own
 *   POST /nodes would. No rule of its own: nodes/service.ts decides.
 *
 * The node body quotes the source with names and times and links the node
 * the thread lives on; `source_thread` (the same shape as promote) points at
 * the thread; a `discussed-in` relation records (thread, message, kind) and
 * makes the action idempotent; the thread gets a reply card, as promote
 * posts one. Attribution is the caller — a person. An agent calling it
 * (`client.agent`) creates the proposal under the person's login with the
 * agent recorded as proposer, through the one actor seam
 * (channels/actor-label.ts).
 *
 * Text this server composes — the quoted body and the reply — never fans out
 * @mentions or wakes an agent (createNode notifyMentions:false; the reply
 * skips the fan-out), the rule promote set.
 */
import { createNode, type SourceThread } from "../nodes/service.js";
import { submitForReview } from "../governance/review-service.js";
import { addComment, setThreadStatus, syncAnnotationsNode } from "../annotations/service.js";
import { findThreadRelations, recordThreadRelation } from "../nodes/relations.js";
import { getCurrentVersion } from "../governance/version-service.js";
import { getDb } from "../db/client.js";
import { justWritten } from "../mentions/mention-index.js";
import { ValidationError } from "../shared/errors.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import type { ActorLabel } from "../channels/actor-label.js";
import { deriveTitle, MAX_SUMMARY } from "../stream/promote.js";
import { nodeUrl, proposerLabel, quotedMessages, type SourceMessage } from "./format.js";
import { assertMayWriteFromThread, messageIn, readableThread, threadMessages, type MemoryCaller } from "./threads.js";

export const REMEMBER_KINDS = ["note", "decision", "task", "fact"] as const;
export type RememberKind = (typeof REMEMBER_KINDS)[number];
const MAX_TITLE = 200;

const FOLDER: Record<RememberKind, string> = { note: "notes", decision: "decisions", task: "tasks", fact: "facts" };
const TAGS: Record<RememberKind, string[]> = { note: [], decision: ["#decision"], task: [], fact: ["#fact"] };
const LABEL: Record<RememberKind, string> = { note: "Note", decision: "Decision", task: "Task", fact: "Fact" };

export interface MemoryNodeRef {
  id: string;
  title: string;
  type: string;
  /** draft | pending_review | published — what happened to the write. */
  status: string;
  version: number;
  url: string;
  /** The review request this landed in, or null when it published. */
  review: { id: string } | null;
}

export interface RememberResult {
  node: MemoryNodeRef;
  kind: RememberKind;
  source_thread: SourceThread;
  /** The one message remembered, or null for the whole thread. */
  source_message_id: string | null;
  /** Who proposed it: the caller, with the declared agent if any. */
  proposer: ActorLabel;
  /** The reply posted in the thread (`comment_id` null when nothing was posted). */
  reply: { thread_id: string; comment_id: string | null };
  /** True when this (thread, message, kind) was remembered before: `node` is that node. */
  existing: boolean;
}

export interface RememberCaller extends MemoryCaller {
  /** Attribution for the node's first version (carries the declared agent). */
  client?: ClientMetadata;
  /** Attribution for the reply (a message row: an agent only when declared). Defaults to `client`. */
  replyClient?: ClientMetadata;
}

export function parseRememberKind(raw: unknown): RememberKind {
  if (raw === undefined || raw === null || raw === "") return "note";
  const k = String(raw).trim().toLowerCase();
  if ((REMEMBER_KINDS as readonly string[]).includes(k)) return k as RememberKind;
  throw new ValidationError(`kind must be one of ${REMEMBER_KINDS.join(", ")}`);
}

/** What the node's write came to, after createNode (and submitForReview when it drafted). */
export function writeStatus(fmStatus: unknown, reviewId: string | null): string {
  if (reviewId) return "pending_review";
  const s = String(fmStatus ?? "draft");
  return s === "published" || s === "approved" ? "published" : "draft";
}

/** The node's current head, for an `existing` answer. */
async function headOf(nestId: string, nodeId: string): Promise<{ title: string; type: string; status: string; version: number; review: { id: string } | null }> {
  const db = getDb();
  const idx = (await db.get("SELECT title, type, status FROM node_index WHERE nest_id = ? AND node_id = ?", [nestId, nodeId])) as
    | { title: string; type: string; status: string }
    | undefined;
  const pending = (await db.get("SELECT id FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' LIMIT 1", [nestId, nodeId])) as
    | { id: string }
    | undefined;
  return {
    title: idx?.title || nodeId,
    type: idx?.type || "document",
    status: pending ? "pending_review" : writeStatus(idx?.status, null),
    version: await getCurrentVersion(nestId, nodeId),
    review: pending ? { id: pending.id } : null,
  };
}

export async function rememberThread(
  caller: RememberCaller,
  input: { thread: unknown; message_id?: unknown; kind?: unknown; title?: unknown; summary?: unknown; folder?: unknown },
): Promise<RememberResult> {
  const kind = parseRememberKind(input.kind);
  if (input.title !== undefined && input.title !== null && typeof input.title !== "string") throw new ValidationError("title must be a string");
  if (input.folder !== undefined && input.folder !== null && typeof input.folder !== "string") throw new ValidationError("folder must be a string");
  if (input.summary !== undefined && input.summary !== null && typeof input.summary !== "string") throw new ValidationError("summary must be a string");
  if (input.message_id !== undefined && input.message_id !== null && typeof input.message_id !== "string") throw new ValidationError("message_id must be a string");
  const summary = String(input.summary ?? "").trim();
  if (summary.length > MAX_SUMMARY) throw new ValidationError(`summary is at most ${MAX_SUMMARY} characters`);
  const { nestId, userEmail } = caller;

  const thread = await readableThread(caller, input.thread);
  const all = await threadMessages(thread.id);
  const one: SourceMessage | null = input.message_id ? messageIn(all, input.message_id) : null;
  await assertMayWriteFromThread(caller, thread);

  // The declared agent only, as a message row shows it (an API key's label
  // alone is not an agent): the reply attribution carries that rule.
  const proposer = await proposerLabel(userEmail, "replyClient" in caller ? caller.replyClient : caller.client);
  const sourceThread: SourceThread = { node_id: thread.node_id, thread_id: thread.id };
  const messageId = one?.id ?? null;

  // Remembered before, as this kind, from this message (or the whole
  // thread): hand back that node, create nothing, post nothing.
  const earlier = (await findThreadRelations(nestId, { hostNodeIds: [thread.node_id], threadIds: [thread.id] })).find(
    (r) => r.kind === "remembered" && r.message_id === messageId && r.memory_kind === kind,
  );
  if (earlier) {
    const head = await headOf(nestId, earlier.node_id);
    return {
      node: { id: earlier.node_id, ...head, url: nodeUrl(nestId, earlier.node_id) },
      kind,
      source_thread: sourceThread,
      source_message_id: messageId,
      proposer,
      reply: { thread_id: thread.id, comment_id: null },
      existing: true,
    };
  }

  const source = one ? [one] : all;
  const title = (typeof input.title === "string" && input.title.trim() ? input.title.trim() : deriveTitle(source[0]?.body ?? "", kind === "task" ? "task" : "decision")).slice(
    0,
    MAX_TITLE,
  );
  const content =
    `${LABEL[kind]} remembered from ${one ? "a message in" : ""} a thread on [[${thread.node_id}]], by ${proposer.label}.\n\n` +
    (summary ? `${summary}\n\n` : "") +
    `## Source\n\n${await quotedMessages(source)}\n`;
  const folder = typeof input.folder === "string" && input.folder.trim() ? input.folder.trim() : FOLDER[kind];

  const created = await createNode(
    nestId,
    {
      title,
      content,
      type: kind === "task" ? "task" : "document",
      tags: TAGS[kind],
      folder,
      sourceThread,
      ...(caller.client ? { client: caller.client } : {}),
    },
    userEmail,
    { notifyMentions: false },
  );
  const node = created.node;

  // A draft is a proposal: into the review queue, requested by the caller.
  let reviewId: string | null = null;
  const landed = String(node.frontmatter?.status ?? "draft");
  if (landed !== "published" && landed !== "approved") {
    const review = await submitForReview({
      nestId,
      nodeId: node.id,
      version: created.version,
      requestedBy: userEmail,
      note: `Remembered from a thread on ${thread.node_id} by ${proposer.label}`,
      ...(caller.client ? { client: caller.client } : {}),
    });
    reviewId = review.id;
  }

  await recordThreadRelation({
    nestId,
    nodeId: node.id,
    hostNodeId: thread.node_id,
    createdBy: userEmail,
    meta: { thread_id: thread.id, message_id: messageId, kind: "remembered", memory_kind: kind, proposer: proposer.label },
  }).catch((err) => console.warn("[remember] relation not recorded", nestId, node.id, err?.message ?? err));

  const status = writeStatus(landed, reviewId);
  const replied = await addComment(
    nestId,
    thread.node_id,
    thread.id,
    userEmail,
    `Remembered as a ${kind}: [[${node.id}]] — "${title}"${status === "pending_review" ? " (in review)" : ""}`,
    "replyClient" in caller ? caller.replyClient : caller.client,
  );
  if (thread.status === "resolved") {
    await setThreadStatus(nestId, thread.node_id, thread.id, "resolved", userEmail).catch(() => {});
  }
  await syncAnnotationsNode(nestId, thread.node_id, userEmail);

  return {
    node: {
      id: node.id,
      title: String(node.frontmatter?.title ?? title),
      type: String(node.frontmatter?.type ?? (kind === "task" ? "task" : "document")),
      status,
      version: created.version,
      url: nodeUrl(nestId, node.id),
      review: reviewId ? { id: reviewId } : null,
    },
    kind,
    source_thread: sourceThread,
    source_message_id: messageId,
    proposer,
    reply: { thread_id: thread.id, comment_id: justWritten(replied, userEmail) },
    existing: false,
  };
}

export function rememberText(r: RememberResult): string {
  if (r.existing) {
    return `This ${r.source_message_id ? "message" : "thread"} was already remembered as a ${r.kind}: "${r.node.title}" (${r.node.id}, ${r.node.status}). Nothing new was created.`;
  }
  const where =
    r.node.status === "pending_review"
      ? `It is a draft in the review queue (review ${r.node.review?.id}); a reviewer approves it.`
      : r.node.status === "published"
        ? "It is published."
        : "It is a draft.";
  return `Remembered as a ${r.kind}: "${r.node.title}" (${r.node.id}, v${r.node.version}), proposed by ${r.proposer.label}. ${where} The thread has a reply linking it.`;
}
