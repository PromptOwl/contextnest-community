/**
 * Promote a thread to a node (PO-1181, agent team stream S3).
 *
 * One action turns a settled conversation into a governed record: a
 * `decision` (a document tagged #decision under nodes/decisions/) or a `task`
 * (a task node under nodes/tasks/, so the nest's task rules apply — default
 * stage, ticket number). Its body is an optional summary, then the thread
 * quoted message by message with display names and readable times; its
 * `source_thread` points back at the thread (the thread id is data, never
 * body text), it is related to the node the thread lives on (relates_to), and
 * the thread gets a reply linking the new node, so the conversation and the
 * record find each other both ways.
 *
 * Promoting the same thread to the same kind again creates nothing: it
 * returns the node that exists, flagged `existing: true` (PO-1189, AC-UX-11).
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
import { filterAccessible } from "../governance/access-guard.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { canCreateInNest } from "../governance/stewardship-service.js";
import { resolveNestAccess } from "../shared/access.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { deserializeClient, type ClientMetadata } from "../shared/client-metadata.js";
import { createNode, type SourceThread } from "../nodes/service.js";
import { addRelation } from "../nodes/relations.js";
import { addComment, setThreadStatus, syncAnnotationsNode } from "../annotations/service.js";
import { channelPostRefusal } from "../channels/channel-service.js";
import { displayNames, namedActor } from "../channels/message-meta.js";
import { justWritten } from "../mentions/mention-index.js";
import { config } from "../config.js";

export const PROMOTE_KINDS = ["decision", "task"] as const;
export type PromoteKind = (typeof PROMOTE_KINDS)[number];
/** Most messages a promoted body quotes (the rest are counted, not copied). */
export const MAX_QUOTED_MESSAGES = 200;
const MAX_TITLE = 200;
/** The longest title derived from the thread's first line. */
export const MAX_DERIVED_TITLE = 80;
export const MAX_SUMMARY = 1000;

export interface PromoteResult {
  node: { id: string; title: string; type: string; status: string; version: number; url: string };
  source_thread: SourceThread;
  /** The reply posted in the thread, linking the node (`comment_id` is null
   *  when nothing was posted because the node already existed). */
  reply: { thread_id: string; comment_id: string | null };
  /** True when this thread had already been promoted to this kind: `node` is
   *  that earlier node and nothing was created. */
  existing: boolean;
}

/** A node a thread was promoted to, as a timeline post shows it. */
export interface PromotedRef {
  kind: PromoteKind;
  node_id: string;
  title: string;
}

interface PromotedRow extends PromotedRef {
  thread_id: string;
  status: string;
  version: number | null;
  type: string;
}

/**
 * Every node in the nest that records `source_thread` for one of these
 * threads. Read from the node index (the row's frontmatter carries
 * `metadata.source_thread`); the LIKE is only a prefilter, the parse decides.
 */
async function promotedRows(nestId: string, threadIds: string[]): Promise<PromotedRow[]> {
  if (threadIds.length === 0) return [];
  const wanted = new Set(threadIds);
  const rows = (await getDb().all(
    `SELECT node_id, title, type, status, frontmatter_json FROM node_index
      WHERE nest_id = ? AND frontmatter_json LIKE '%"source_thread"%'
      ORDER BY node_id`,
    [nestId],
  )) as Array<{ node_id: string; title: string; type: string; status: string; frontmatter_json: string }>;
  const out: PromotedRow[] = [];
  for (const r of rows) {
    let fm: any;
    try {
      fm = JSON.parse(r.frontmatter_json);
    } catch {
      continue;
    }
    const threadId = fm?.metadata?.source_thread?.thread_id;
    if (typeof threadId !== "string" || !wanted.has(threadId)) continue;
    out.push({
      thread_id: threadId,
      kind: r.type === "task" ? "task" : "decision",
      node_id: r.node_id,
      title: r.title || r.node_id,
      status: r.status,
      type: r.type,
      version: typeof fm?.version === "number" ? fm.version : null,
    });
  }
  return out;
}

/**
 * The nodes each of these threads was promoted to, for THIS reader: one they
 * can't open is left out, like an artifact card they can't read.
 */
export async function promotedFromThreads(
  caller: { nestId: string; userId: string; userEmail: string },
  threadIds: string[],
): Promise<Map<string, PromotedRef[]>> {
  const out = new Map<string, PromotedRef[]>();
  const rows = await promotedRows(caller.nestId, threadIds);
  if (rows.length === 0) return out;
  const readable = new Set(
    (await filterAccessible(caller.nestId, caller.userId, caller.userEmail, rows.map((r) => ({ id: r.node_id })))).map((n) => n.id),
  );
  for (const r of rows) {
    if (!readable.has(r.node_id)) continue;
    const list = out.get(r.thread_id) ?? [];
    list.push({ kind: r.kind, node_id: r.node_id, title: r.title });
    out.set(r.thread_id, list);
  }
  return out;
}

export interface PromoteCaller {
  nestId: string;
  userId: string;
  userEmail: string;
  /** Attribution for the node's first version. */
  client?: ClientMetadata;
  /** Attribution for the reply posted in the thread (a message row: an agent
   *  only when declared, channels/message-meta.ts). Defaults to `client`. */
  replyClient?: ClientMetadata;
}

function parseKind(raw: unknown): PromoteKind {
  if (raw === undefined || raw === null || raw === "") return "decision";
  const k = String(raw).trim().toLowerCase();
  if ((PROMOTE_KINDS as readonly string[]).includes(k)) return k as PromoteKind;
  throw new ValidationError(`kind must be one of ${PROMOTE_KINDS.join(", ")}`);
}

/**
 * A title from the thread's first line, at most MAX_DERIVED_TITLE characters:
 * leading @names dropped, markdown marks and wikilink brackets removed, so it
 * reads as a title rather than as a chat line.
 */
export function deriveTitle(firstBody: string, kind: PromoteKind = "decision"): string {
  const line =
    String(firstBody ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  const flat = line
    .replace(/^#+\s*/, "")
    .replace(/^(@(\([^)]*\)|[\w.@-]+)[\s,:]*)+/, "")
    .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return kind === "task" ? "Task from a thread" : "Decision from a thread";
  return flat.length > MAX_DERIVED_TITLE ? `${flat.slice(0, MAX_DERIVED_TITLE - 1).trimEnd()}…` : flat;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-09 13:41:44.927" (stored, UTC) → "9 Nov 2026, 13:41 UTC". */
export function readableTime(stored: string): string {
  const d = new Date(/^\d{4}-\d\d-\d\d \d/.test(stored) ? `${stored.replace(" ", "T")}Z` : stored);
  if (Number.isNaN(d.getTime())) return stored;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

function quote(text: string): string {
  return String(text ?? "")
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

export async function promoteThread(
  caller: PromoteCaller,
  input: { thread: unknown; kind?: unknown; title?: unknown; summary?: unknown; folder?: unknown },
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
  if (input.summary !== undefined && input.summary !== null && typeof input.summary !== "string") {
    throw new ValidationError("summary must be a string");
  }
  const summary = String(input.summary ?? "").trim();
  if (summary.length > MAX_SUMMARY) throw new ValidationError(`summary is at most ${MAX_SUMMARY} characters`);
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

  // Already promoted to this kind: hand back that node, create nothing, post
  // nothing. The caller can read the thread, whose reply already names it.
  const sourceThread: SourceThread = { node_id: row.node_id, thread_id: threadId };
  const earlier = (await promotedRows(nestId, [threadId])).find((p) => p.kind === kind);
  if (earlier) {
    const head = (await db.get(
      "SELECT MAX(version) AS v FROM node_versions WHERE nest_id = ? AND node_id = ?",
      [nestId, earlier.node_id],
    ).catch(() => undefined)) as { v: number | null } | undefined;
    return {
      node: {
        id: earlier.node_id,
        title: earlier.title,
        type: earlier.type,
        status: earlier.status,
        version: Number(head?.v ?? earlier.version ?? 1),
        url: `/nest/${encodeURIComponent(nestId)}?doc=${encodeURIComponent(earlier.node_id)}`,
      },
      source_thread: sourceThread,
      reply: { thread_id: threadId, comment_id: null },
      existing: true,
    };
  }

  const comments = (await db.all(
    `SELECT id, author, body, created_at, client_json FROM annotation_comments
      WHERE thread_id = ? ORDER BY created_at ASC, id ASC`,
    [threadId],
  )) as Array<{ id: string; author: string; body: string; created_at: string; client_json: string | null }>;

  const title = (typeof input.title === "string" && input.title.trim()
    ? input.title.trim()
    : deriveTitle(comments[0]?.body ?? "", kind)
  ).slice(0, MAX_TITLE);

  const names = await displayNames(comments.map((c) => c.author));
  const quoted: string[] = [];
  for (const c of comments.slice(0, MAX_QUOTED_MESSAGES)) {
    const who = (await namedActor(c.author, deserializeClient(c.client_json), names)).actor;
    quoted.push(`> **${who.label}** · ${readableTime(c.created_at)}\n${quote(c.body)}`);
  }
  const more = comments.length > MAX_QUOTED_MESSAGES ? `\n\n…and ${comments.length - MAX_QUOTED_MESSAGES} more message(s) in the thread.` : "";
  const label = kind === "decision" ? "Decision" : "Task";
  const content =
    `${label} promoted from a thread on [[${row.node_id}]].\n\n` +
    (summary ? `${summary}\n\n` : "") +
    `## Thread\n\n${quoted.join("\n\n") || "_The thread has no messages._"}${more}\n`;

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
    "replyClient" in caller ? caller.replyClient : caller.client,
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
    existing: false,
  };
}

export function promoteText(r: PromoteResult): string {
  if (r.existing) {
    return `This thread was already promoted to ${r.node.type === "task" ? "a task" : "a decision"}: "${r.node.title}" (${r.node.id}). Nothing new was created; update that node instead.`;
  }
  return (
    `Promoted the thread to ${r.node.type === "task" ? "a task" : "a decision"}: "${r.node.title}" (${r.node.id}, v${r.node.version}, ${r.node.status}). ` +
    `Its source_thread points at thread ${r.source_thread.thread_id} on ${r.source_thread.node_id}, and the thread has a reply linking it.`
  );
}
