/**
 * Mention notifications — tell someone their name came up.
 *
 * Two entry points over one resolver: `notifyMentions` for a document body
 * (only what a save ADDS notifies) and `notifyCommentMentions` for a comment
 * (every name in the new comment, since the text is new). Both land an inbox
 * row and, when channels are configured, a message — the queue and the ping
 * are the same event delivered twice.
 *
 * Its own module rather than part of notify-service: resolving a mention needs
 * the nest's people, and that lookup sits on the teams-service →
 * notify-service import chain.
 *
 * Best-effort by the same contract the rest of the fan-outs keep: a
 * notification failure must never fail the save or the comment that triggered
 * it.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { listNestPeople } from "../nests/people-service.js";
import { extractMentions, newMentions, resolveMention } from "../shared/mentions.js";
import { isDerivedAnnotationsId } from "../shared/node-id.js";
import { buildDocContext } from "./title-resolver.js";
import { canReadNode } from "./access-guard.js";
import { resolveNestAccess } from "../shared/access.js";
import { resolveNodeGrant } from "./grants-service.js";
import { dispatchEvent } from "../notify/dispatch.js";
import { sendEmailToRecipient } from "../notify/email.js";

/**
 * Can this person open this document at all?
 *
 * canReadNode is an open read on a nest without stewardship, which is right
 * for a member but wrong for someone whose only way in is a share grant: their
 * scoping lives in the request middleware (resolveNodeGrant per node), not in
 * that helper. So a grant holder is checked against their grants directly —
 * otherwise a mention would announce a document, and its title, to someone
 * granted a different one.
 */
async function canOpenNode(
  nestId: string,
  nodeId: string,
  userId: string,
  email: string,
): Promise<boolean> {
  const access = await resolveNestAccess(nestId, userId);
  if (access.permission === "none") {
    return (await resolveNodeGrant(nestId, userId, nodeId)) !== null;
  }
  return canReadNode(nestId, nodeId, userId, email);
}

interface Recipient {
  email: string;
  userId: string;
}

/**
 * The people a list of written `@names` actually reaches: resolved against the
 * nest's roster, deduped, minus the author, minus anyone who can't open the
 * document. A name that matches nobody reaches nobody — the editor already
 * draws it as unresolved.
 */
async function resolveRecipients(params: {
  nestId: string;
  nodeId: string;
  names: string[];
  actorEmail: string;
}): Promise<Recipient[]> {
  const { nestId, nodeId, names, actorEmail } = params;
  if (names.length === 0) return [];

  const people = await listNestPeople(nestId);
  const actor = actorEmail.toLowerCase();
  const candidates = new Map<string, Recipient>();
  for (const name of names) {
    const person = resolveMention(people, name);
    // No account means no inbox to read — a steward invited by email who
    // never signed up hears about it when they're actually a user.
    if (!person?.userId) continue;
    const key = person.email.toLowerCase();
    if (key === actor || candidates.has(key)) continue;
    candidates.set(key, { email: person.email, userId: person.userId });
  }

  const recipients: Recipient[] = [];
  for (const r of candidates.values()) {
    if (await canOpenNode(nestId, nodeId, r.userId, r.email)) recipients.push(r);
  }
  return recipients;
}

/** Inbox row per recipient. `subject_id` is the node id: listNotifications
 *  resolves a 'mention' row's document straight from it (there is no request
 *  row to join), so the queue entry links to the document. */
async function insertInboxRows(params: {
  nestId: string;
  nodeId: string;
  recipients: Recipient[];
  message: string;
}): Promise<number> {
  const db = getDb();
  const now = new Date().toISOString();
  let created = 0;
  for (const r of params.recipients) {
    await db.run(
      `INSERT INTO notifications (id, nest_id, user_email, kind, subject_id, message, created_at)
       VALUES (?, ?, ?, 'mention', ?, ?, ?)`,
      [uuid(), params.nestId, r.email.toLowerCase(), params.nodeId, params.message, now],
    );
    created++;
  }
  return created;
}

/**
 * The outbound half: the configured connectors (server-wide Slack/Teams webhook
 * or a per-nest connector row) plus a direct email to each person named, when
 * SMTP is set up. Both are fire-and-forget by their own contract — `void`, not
 * awaited, so a mention never waits on a mail server.
 *
 * The email goes to the person named, not the NOTIFY_EMAIL_TO team inbox: a
 * mention is addressed to one human. The connector message is the team-channel
 * half and carries no more than the queue row already does.
 */
function deliverMentionMessages(params: {
  nestId: string;
  nodeId: string;
  recipients: Recipient[];
  message: string;
  actorEmail: string;
  excerpt: string;
  ctx: { docTitle: string; path: string; link: string };
}): void {
  const { nestId, nodeId, recipients, message, actorEmail, excerpt, ctx } = params;
  void dispatchEvent({
    kind: "mention",
    nestId,
    subjectId: nodeId,
    actor: actorEmail,
    message,
  });
  for (const r of recipients) {
    void sendEmailToRecipient(r.email, {
      status: "mention",
      docTitle: ctx.docTitle,
      path: ctx.path,
      link: ctx.link,
      actor: actorEmail,
      note: excerpt || null,
    });
  }
}

/** A comment trimmed to a line that fits a notification. */
function excerptOf(body: string, max = 140): string {
  const s = (body || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Drop a notification for everyone newly mentioned in a document body.
 *
 * Only NEW mentions notify: the same `@name` surviving a dozen saves is one
 * event, not a dozen. The author never hears about their own mention.
 */
export async function notifyMentions(params: {
  nestId: string;
  nodeId: string;
  /** Body before this save; "" for a document being created. */
  previousBody: string;
  nextBody: string;
  /** Who wrote the mention. */
  actorEmail: string;
  baseUrl?: string;
}): Promise<number> {
  const { nestId, nodeId, previousBody, nextBody, actorEmail, baseUrl } = params;
  try {
    // An artifact's comment threads are re-projected into a derived
    // `— Annotations` document on every comment, and that projection is an
    // ordinary save. Notifying on it would fire a SECOND mention for a comment
    // notifyCommentMentions has already delivered, pointing the reader at the
    // projection instead of the artifact they were named in.
    if (isDerivedAnnotationsId(nodeId)) return 0;

    const names = newMentions(previousBody, nextBody);
    const recipients = await resolveRecipients({ nestId, nodeId, names, actorEmail });
    if (recipients.length === 0) return 0;

    const ctx = await buildDocContext(nestId, nodeId, baseUrl);
    const message = `${actorEmail} mentioned you in "${ctx.label}"`;
    const created = await insertInboxRows({ nestId, nodeId, recipients, message });
    deliverMentionMessages({
      nestId,
      nodeId,
      recipients,
      message,
      actorEmail,
      excerpt: "",
      ctx,
    });
    return created;
  } catch (err) {
    console.error("[notify] mention fan-out failed", nestId, nodeId, err);
    return 0;
  }
}

/**
 * Drop a notification for everyone named in a comment.
 *
 * Unlike a document save there is no "previous" text to diff against: the
 * comment itself is the new thing, so every name in it notifies — including
 * one already named upthread. A reply that adds no name adds no notification.
 */
export async function notifyCommentMentions(params: {
  nestId: string;
  nodeId: string;
  body: string;
  /** Who wrote the comment. */
  actorEmail: string;
  baseUrl?: string;
}): Promise<number> {
  const { nestId, nodeId, body, actorEmail, baseUrl } = params;
  try {
    const names = extractMentions(body || "");
    const recipients = await resolveRecipients({ nestId, nodeId, names, actorEmail });
    if (recipients.length === 0) return 0;

    const ctx = await buildDocContext(nestId, nodeId, baseUrl);
    const excerpt = excerptOf(body);
    const message = `${actorEmail} mentioned you in a comment on "${ctx.label}"`;
    const created = await insertInboxRows({ nestId, nodeId, recipients, message });
    deliverMentionMessages({
      nestId,
      nodeId,
      recipients,
      message,
      actorEmail,
      excerpt,
      ctx,
    });
    return created;
  } catch (err) {
    console.error("[notify] comment mention fan-out failed", nestId, nodeId, err);
    return 0;
  }
}
