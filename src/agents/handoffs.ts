/**
 * Handoffs (C7, PO-1198): "take it from here" between people and agents,
 * recorded in the thread as ORDINARY messages.
 *
 * A handoff is a reply by the caller whose body mentions the target
 * (`Handoff to @grok: <note>`) and whose stored attribution carries
 * `handoff: { handoff_id, from, to, to_kind, note, status }`. Because it is
 * a normal message through the normal fan-out (channels/post-message.ts), the
 * target hears about it the way they hear about any mention: a person gets a
 * My Work row and a notification, an agent with a webhook is woken, one
 * without finds it in its context_my_work. Accept and done are further
 * replies by whoever takes it (`handoff_update: { handoff_id, status }`), and
 * the original message's `handoff.status` is moved along, so a thread read
 * shows the current state on the handoff itself. No table.
 *
 * Members only (the channel posting rule), NotFound for anyone else and for
 * a thread the caller can't read; bounded note; the target must be a person
 * on the nest or a known agent (never a reserved handle).
 */
import { getDb } from "../db/client.js";
import { addComment, syncAnnotationsNode } from "../annotations/service.js";
import { canOpenNode } from "../governance/mention-notify.js";
import { listNestPeople } from "../nests/people-service.js";
import { resolveMention } from "../shared/mentions.js";
import { deserializeClient, serializeClient, type ClientMetadata } from "../shared/client-metadata.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { isChannelNode } from "../channels/channel-node.js";
import { channelPostRefusal, isNestMember } from "../channels/channel-service.js";
import { callerSafeClient, displayNames, knownAgents, namedActor, normHandle } from "../channels/message-meta.js";
import { fanOutPostedMessage, type MentionOutcome } from "../channels/post-message.js";
import { justWritten } from "../mentions/mention-index.js";
import { isReservedHandle } from "./reserved.js";
import { nodeWriteKey, withNodeWriteLock } from "../shared/node-write-lock.js";

export const MAX_HANDOFF_NOTE = 1000;
export type HandoffStatus = "open" | "accepted" | "done";

export interface HandoffView {
  /** The handoff message's id. */
  handoff_id: string;
  node_id: string;
  channel: string | null;
  thread_id: string;
  /** The label of whoever handed off (an agent "on behalf of" a person, or the person). */
  from: string;
  from_email: string;
  to: string;
  to_kind: "person" | "agent";
  note: string | null;
  status: HandoffStatus;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
}

export interface HandoffCaller {
  nestId: string;
  userId: string;
  userEmail: string;
  baseUrl?: string;
  /** The caller's own attribution (an agent handing off declares itself). */
  client?: ClientMetadata;
}

async function readableChannelThread(caller: HandoffCaller, threadId: string): Promise<{ nodeId: string }> {
  const row = (await getDb().get("SELECT id, node_id FROM annotation_threads WHERE id = ? AND nest_id = ?", [threadId, caller.nestId])) as
    | { id: string; node_id: string }
    | undefined;
  if (
    !row ||
    !(await isNestMember(caller.nestId, caller.userId)) ||
    !(await isChannelNode(caller.nestId, row.node_id)) ||
    !(await canOpenNode(caller.nestId, row.node_id, caller.userId, caller.userEmail))
  ) {
    throw new NotFoundError("Thread not found");
  }
  return { nodeId: row.node_id };
}

/** Who a handoff goes to: a person on the nest (by name or email) or a known agent. */
async function resolveTarget(nestId: string, raw: unknown): Promise<{ to: string; to_kind: "person" | "agent"; mention: string }> {
  const name = String(raw ?? "").trim().replace(/^@/, "");
  if (!name || name.length > 200) throw new ValidationError("to is required — a person on this nest (name or email) or an agent's handle.");
  if (isReservedHandle(name)) throw new ValidationError(`"${name.toLowerCase()}" can't take a handoff; name a person or an agent.`);
  const person = resolveMention(await listNestPeople(nestId), name);
  if (person?.userId) return { to: person.email.toLowerCase(), to_kind: "person", mention: `@${person.email.toLowerCase()}` };
  const agent = (await knownAgents(nestId)).find((a) => a.handle === normHandle(name));
  if (agent) return { to: agent.handle, to_kind: "agent", mention: `@${agent.handle}` };
  throw new ValidationError("to must be a person on this nest or a known agent handle.");
}

function parseNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ValidationError("note must be a string");
  const note = raw.replace(/\s+/g, " ").trim();
  if (note.length > MAX_HANDOFF_NOTE) throw new ValidationError(`note is at most ${MAX_HANDOFF_NOTE} characters`);
  return note || null;
}

function viewOf(nodeId: string, threadId: string, id: string, createdAt: string, h: Record<string, unknown>): HandoffView {
  return {
    handoff_id: id,
    node_id: nodeId,
    channel: nodeId.split("/").pop() ?? null,
    thread_id: threadId,
    from: String(h.from ?? ""),
    from_email: String(h.from_email ?? ""),
    to: String(h.to ?? ""),
    to_kind: h.to_kind === "person" ? "person" : "agent",
    note: typeof h.note === "string" ? h.note : null,
    status: h.status === "accepted" || h.status === "done" ? h.status : "open",
    created_at: createdAt,
    updated_by: typeof h.updated_by === "string" ? h.updated_by : null,
    updated_at: typeof h.updated_at === "string" ? h.updated_at : null,
  };
}

export async function createHandoff(
  caller: HandoffCaller,
  rawThreadId: unknown,
  input: { to: unknown; note?: unknown },
): Promise<{ handoff: HandoffView; message: { id: string; thread_id: string }; mentions: MentionOutcome[] }> {
  const threadId = typeof rawThreadId === "string" ? rawThreadId.trim() : "";
  if (!threadId) throw new ValidationError("thread is required");
  const { nodeId } = await readableChannelThread(caller, threadId);
  const refusal = await channelPostRefusal(caller.nestId, nodeId, caller.userId, caller.userEmail);
  if (refusal) throw refusal.status === 409 ? new ConflictError(refusal.error) : new ForbiddenError(refusal.error);
  const note = parseNote(input.note);
  const target = await resolveTarget(caller.nestId, input.to);
  const client = callerSafeClient(caller.client);
  const { actor } = await namedActor(caller.userEmail, client, await displayNames([caller.userEmail]));
  const body = `Handoff to ${target.mention}${note ? `: ${note}` : ""}`;
  const thread = await addComment(caller.nestId, nodeId, threadId, caller.userEmail, body, client);
  const id = justWritten(thread, caller.userEmail);
  if (!id) throw new Error("handoff message not written");
  const handoff: Record<string, unknown> = {
    handoff_id: id,
    from: actor.label,
    from_email: caller.userEmail,
    to: target.to,
    to_kind: target.to_kind,
    note,
    status: "open",
    updated_by: null,
    updated_at: null,
  };
  await getDb().run("UPDATE annotation_comments SET client_json = ? WHERE id = ?", [serializeClient({ ...(client ?? {}), handoff } as unknown as ClientMetadata), id]);
  // The ordinary fan-out: the target's My Work row, notification, wake-up.
  const posted = await fanOutPostedMessage({
    nestId: caller.nestId,
    nodeId,
    thread,
    isReply: true,
    body,
    authorEmail: caller.userEmail,
    authorUserId: caller.userId,
    baseUrl: caller.baseUrl,
  });
  const created = thread.comments.find((c) => c.id === id)?.createdAt ?? new Date().toISOString();
  return { handoff: viewOf(nodeId, threadId, id, created, handoff), message: { id, thread_id: threadId }, mentions: posted.mentions };
}

export async function updateHandoff(
  caller: HandoffCaller,
  rawMessageId: unknown,
  status: Exclude<HandoffStatus, "open">,
  rawNote?: unknown,
): Promise<{ handoff: HandoffView; message: { id: string; thread_id: string } }> {
  const messageId = typeof rawMessageId === "string" ? rawMessageId.trim() : "";
  if (!messageId) throw new ValidationError("message id is required");
  const db = getDb();
  // Serialised per handoff message: two "accept"s at once must not both win
  // (security review r2 F10). The status is read, checked and written under
  // one lock, and the write is conditional on the row as read.
  return withNodeWriteLock(nodeWriteKey(caller.nestId, `handoff:${messageId}`), async () => {
  const row = (await db.get(
    `SELECT c.id, c.thread_id, c.created_at, c.client_json, t.node_id
       FROM annotation_comments c JOIN annotation_threads t ON t.id = c.thread_id
      WHERE c.id = ? AND t.nest_id = ?`,
    [messageId, caller.nestId],
  )) as { id: string; thread_id: string; created_at: string; client_json: string | null; node_id: string } | undefined;
  const client = row ? (deserializeClient(row.client_json) as Record<string, unknown> | undefined) : undefined;
  const handoff = client?.handoff && typeof client.handoff === "object" ? { ...(client.handoff as Record<string, unknown>) } : null;
  // One answer for "no such message", "not a handoff" and "can't read it".
  if (!row || !handoff) throw new NotFoundError("Handoff not found");
  await readableChannelThread(caller, row.thread_id);
  const refusal = await channelPostRefusal(caller.nestId, row.node_id, caller.userId, caller.userEmail);
  if (refusal) throw refusal.status === 409 ? new ConflictError(refusal.error) : new ForbiddenError(refusal.error);
  const current = handoff.status === "accepted" || handoff.status === "done" ? handoff.status : "open";
  if (current === "done" || (status === "accepted" && current === "accepted")) {
    throw new ConflictError(`This handoff is already ${current}.`);
  }
  const note = parseNote(rawNote);
  const now = new Date().toISOString();
  const ownClient = callerSafeClient(caller.client);
  const body = `Handoff ${status === "accepted" ? "accepted" : "done"}${note ? `: ${note}` : ""}`;
  const thread = await addComment(caller.nestId, row.node_id, row.thread_id, caller.userEmail, body, {
    ...(ownClient ?? {}),
    handoff_update: { handoff_id: messageId, status, note },
  } as unknown as ClientMetadata);
  handoff.status = status;
  handoff.updated_by = caller.userEmail;
  handoff.updated_at = now;
  const written = await db.run("UPDATE annotation_comments SET client_json = ? WHERE id = ? AND client_json = ?", [
    serializeClient({ ...client, handoff } as unknown as ClientMetadata),
    messageId,
    row.client_json,
  ]);
  if (!written.changes) throw new ConflictError("This handoff changed while you were taking it; read the thread again.");
  await syncAnnotationsNode(caller.nestId, row.node_id, caller.userEmail).catch(() => {});
  const update = justWritten(thread, caller.userEmail) ?? "";
  return { handoff: viewOf(row.node_id, row.thread_id, messageId, row.created_at, handoff), message: { id: update, thread_id: row.thread_id } };
  });
}

export function handoffText(h: HandoffView): string {
  return `Handoff ${h.handoff_id} in #${h.channel} thread ${h.thread_id}: from ${h.from} to @${h.to} (${h.to_kind}) — ${h.status}${h.note ? `. Note: ${h.note}` : "."}`;
}
