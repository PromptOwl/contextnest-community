/**
 * Promote a thread to a node (PO-1181, agent team stream S3).
 *
 * One action turns a settled conversation into a governed record: a
 * `decision` (a document tagged #decision under nodes/decisions/) or a `task`
 * (a task node under nodes/tasks/, so the nest's task rules apply — default
 * stage, ticket number). Its body quotes the thread message by message, its
 * `source_thread` points back at the thread, it is related to the node the
 * thread lives on (relates_to), and the thread gets a reply linking the new
 * node, so the conversation and the record find each other both ways.
 *
 * One service for REST (POST /nests/:id/threads/:threadId/promote) and MCP
 * (`context_promote_thread`): both return exactly this object (AC-ST-06).
 *
 * Authorisation — every check the separate steps would make, made up front so
 * nothing is half-written on a refusal:
 *   - the caller can read the node the thread is on (else NotFound — the same
 *     answer as a thread that doesn't exist, so a thread id is no oracle);
 *   - the nest isn't archived, and the caller may create documents in it
 *     (canCreateInNest — the context_create / POST /nodes rule);
 *   - on a channel, the caller may post there (channelPostRefusal), because
 *     promoting posts the reply.
 *
 * Text this server composes — the quoted body and the reply — never fans out
 * @mentions (createNode notifyMentions:false; the reply skips notify, the
 * mention index and agent wake-up): the names in it were notified where they
 * were typed, and a promotion must not page them, or wake an agent, again.
 */
import { getDb } from "../db/client.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { canCreateInNest } from "../governance/stewardship-service.js";
import { resolveNestAccess } from "../shared/access.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { deserializeClient, type ClientMetadata } from "../shared/client-metadata.js";
import { createNode, type SourceThread } from "../nodes/service.js";
import { addRelation } from "../nodes/relations.js";
import { addComment, setThreadStatus, syncAnnotationsNode } from "../annotations/service.js";
import { channelPostRefusal } from "../channels/channel-service.js";
import { resolveActorLabel } from "../channels/actor-label.js";
import { justWritten } from "../mentions/mention-index.js";
import { config } from "../config.js";

export const PROMOTE_KINDS = ["decision", "task"] as const;
export type PromoteKind = (typeof PROMOTE_KINDS)[number];
/** Most messages a promoted body quotes (the rest are counted, not copied). */
export const MAX_QUOTED_MESSAGES = 200;
const MAX_TITLE = 200;

export interface PromoteResult {
  node: { id: string; title: string; type: string; status: string; version: number; url: string };
  source_thread: SourceThread;
  /** The reply posted in the thread, linking the node. */
  reply: { thread_id: string; comment_id: string | null };
}

export interface PromoteCaller {
  nestId: string;
  userId: string;
  userEmail: string;
  client?: ClientMetadata;
}

function parseKind(raw: unknown): PromoteKind {
  if (raw === undefined || raw === null || raw === "") return "decision";
  const k = String(raw).trim().toLowerCase();
  if ((PROMOTE_KINDS as readonly string[]).includes(k)) return k as PromoteKind;
  throw new ValidationError(`kind must be one of ${PROMOTE_KINDS.join(", ")}`);
}

function deriveTitle(firstBody: string, threadId: string): string {
  const line =
    String(firstBody ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const flat = line.replace(/\s+/g, " ").replace(/^#+\s*/, "").trim();
  if (!flat) return `Thread ${threadId.slice(0, 8)}`;
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
}

function quote(text: string): string {
  return String(text ?? "")
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

export async function promoteThread(
  caller: PromoteCaller,
  input: { thread: unknown; kind?: unknown; title?: unknown; folder?: unknown },
): Promise<PromoteResult> {
  const kind = parseKind(input.kind);
  const threadId = typeof input.thread === "string" ? input.thread.trim() : "";
  if (!threadId) throw new ValidationError("thread is required — the thread (post) id to promote.");
  if (input.title !== undefined && input.title !== null && typeof input.title !== "string") {
    throw new ValidationError("title must be a string");
  }
  if (input.folder !== undefined && input.folder !== null && typeof input.folder !== "string") {
    throw new ValidationError("folder must be a string");
  }
  const { nestId, userId, userEmail } = caller;
  const db = getDb();

  const row = (await db.get(
    "SELECT id, node_id, status FROM annotation_threads WHERE id = ? AND nest_id = ?",
    [threadId, nestId],
  )) as { id: string; node_id: string; status: "open" | "resolved" } | undefined;
  // canOpenNode: narrows a share grantee to their grants (canReadNode alone
  // trusts the nest middleware to have admitted only members).
  if (!row || !(await canOpenNode(nestId, row.node_id, userId, userEmail))) {
    throw new NotFoundError("Thread not found");
  }
  if (config.AUTH_MODE !== "open" && (await resolveNestAccess(nestId, userId)).archived) {
    throw new ForbiddenError("This nest is archived, so it is read-only.");
  }
  if (!(await canCreateInNest(nestId, userEmail))) {
    throw new ForbiddenError("Promoting a thread creates a node, which needs write access to this nest.");
  }
  const refusal = await channelPostRefusal(nestId, row.node_id, userId, userEmail);
  if (refusal) throw refusal.status === 409 ? new ConflictError(refusal.error) : new ForbiddenError(refusal.error);

  const comments = (await db.all(
    `SELECT id, author, body, created_at, client_json FROM annotation_comments
      WHERE thread_id = ? ORDER BY created_at ASC, id ASC`,
    [threadId],
  )) as Array<{ id: string; author: string; body: string; created_at: string; client_json: string | null }>;

  const title = (typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : deriveTitle(comments[0]?.body ?? "", threadId)
  ).slice(0, MAX_TITLE);

  const quoted: string[] = [];
  for (const c of comments.slice(0, MAX_QUOTED_MESSAGES)) {
    const who = await resolveActorLabel({ email: c.author, client: deserializeClient(c.client_json) });
    quoted.push(`> **${who.label}** · ${c.created_at}\n${quote(c.body)}`);
  }
  const more = comments.length > MAX_QUOTED_MESSAGES ? `\n\n…and ${comments.length - MAX_QUOTED_MESSAGES} more message(s) in the thread.` : "";
  const label = kind === "decision" ? "Decision" : "Task";
  const content =
    `${label} promoted from a thread on [[${row.node_id}]] (thread ${threadId}).\n\n` +
    `## Thread\n\n${quoted.join("\n\n") || "_The thread has no messages._"}${more}\n`;

  const sourceThread: SourceThread = { node_id: row.node_id, thread_id: threadId };
  const folder = typeof input.folder === "string" && input.folder.trim() ? input.folder.trim() : kind === "decision" ? "decisions" : "tasks";
  const created = await createNode(
    nestId,
    {
      title,
      content,
      type: kind === "task" ? "task" : "document",
      tags: kind === "decision" ? ["#decision"] : [],
      folder,
      sourceThread,
      ...(caller.client ? { client: caller.client } : {}),
    },
    userEmail,
    { notifyMentions: false },
  );
  const node = created.node;

  // Best-effort graph edge back to where the conversation lives.
  await addRelation({ nestId, userId, userEmail }, node.id, "relates_to", row.node_id).catch((err) => {
    console.warn("[promote] relation not added", nestId, node.id, row.node_id, err?.message ?? err);
  });

  // The reply that links the node, attributed to the person who promoted.
  // addComment reopens a resolved thread; a promotion shouldn't, so put the
  // status back.
  const thread = await addComment(
    nestId,
    row.node_id,
    threadId,
    userEmail,
    `Promoted to a ${kind}: [[${node.id}]] — "${title}"`,
    caller.client,
  );
  if (row.status === "resolved") {
    await setThreadStatus(nestId, row.node_id, threadId, "resolved", userEmail).catch(() => {});
  }
  await syncAnnotationsNode(nestId, row.node_id, userEmail);

  return {
    node: {
      id: node.id,
      title: String(node.frontmatter?.title ?? title),
      type: String(node.frontmatter?.type ?? (kind === "task" ? "task" : "document")),
      status: String(node.frontmatter?.status ?? "draft"),
      version: created.version,
      url: `/nest/${encodeURIComponent(nestId)}?doc=${encodeURIComponent(node.id)}`,
    },
    source_thread: sourceThread,
    reply: { thread_id: threadId, comment_id: justWritten(thread, userEmail) },
  };
}

export function promoteText(r: PromoteResult): string {
  return (
    `Promoted the thread to ${r.node.type === "task" ? "a task" : "a decision"}: "${r.node.title}" (${r.node.id}, v${r.node.version}, ${r.node.status}). ` +
    `Its source_thread points at thread ${r.source_thread.thread_id} on ${r.source_thread.node_id}, and the thread has a reply linking it.`
  );
}
