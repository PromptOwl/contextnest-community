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
import { listNestPeople, findDirectoryPerson } from "../nests/people-service.js";
import {
  MAX_MENTION_RECIPIENTS,
  extractMentions,
  newMentions,
  resolveMention,
} from "../shared/mentions.js";
import { buildDocContext } from "./title-resolver.js";
import { canReadNode } from "./access-guard.js";
import { resolveNestAccess, permissionLevel } from "../shared/access.js";
import { resolveNodeGrant } from "./grants-service.js";
import { dispatchEvent, hasAnyConnector } from "../notify/dispatch.js";
import { isEmailConfigured, sendEmailToRecipient } from "../notify/email.js";
import { tryConsume } from "../shared/rate-limit.js";
import { insertNotification } from "../notify/inbox.js";
import { listWatchers } from "./notify-service.js";
import { resolveStewardsForNode } from "./stewardship-service.js";

/**
 * Can this person open this document at all?
 *
 * canReadNode is an open read on a nest without stewardship, which is right
 * for a member but wrong for someone whose only way in is a share grant: their
 * scoping lives in the request middleware (resolveNodeGrant per node), not in
 * that helper. So a grant holder is checked against their grants directly —
 * otherwise a mention would announce a document, and its title, to someone
 * granted a different one. Every fan-out that names a document (mentions,
 * replies, follower comments, review SLA escalation) gates on this.
 */
export async function canOpenNode(
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
 * document, and capped at MAX_MENTION_RECIPIENTS. A name that matches nobody
 * reaches nobody — the editor already draws it as unresolved.
 */
async function resolveRecipients(params: {
  nestId: string;
  nodeId: string;
  names: string[];
  actorEmail: string;
}): Promise<Recipient[]> {
  const { nestId, nodeId, names, actorEmail } = params;
  if (names.length === 0) return [];

  const roster = await listNestPeople(nestId);
  const actor = actorEmail.toLowerCase();
  const candidates = new Map<string, Recipient>();
  const outsiders: Recipient[] = [];
  for (const name of names) {
    // Roster first so a directory namesake can't make a member's name ambiguous.
    const member = resolveMention(roster, name);
    const person = member ?? (await findDirectoryPerson(name));
    // No account means no inbox to read — a steward invited by email who
    // never signed up hears about it when they're actually a user.
    if (!person?.userId) continue;
    const key = person.email.toLowerCase();
    if (key === actor || candidates.has(key)) continue;
    const r = { email: person.email, userId: person.userId };
    candidates.set(key, r);
    if (!member) outsiders.push(r);
    // Capped here rather than after the loop: everything past this point —
    // one access check, one row, one email per candidate — is work this write
    // causes, and the point of the cap is to bound it. Names are visited in
    // order of appearance, so the first people named are the ones notified.
    if (candidates.size >= MAX_MENTION_RECIPIENTS) break;
  }
  if (outsiders.length) await inviteMentioned(nestId, actorEmail, outsiders);

  // Access-checked in parallel: each check is a couple of independent reads,
  // and a comment naming a handful of people shouldn't serialise all of them.
  const checked = await Promise.all(
    [...candidates.values()].map(async (r) => ({
      r,
      allowed: await canOpenNode(nestId, nodeId, r.userId, r.email),
    })),
  );
  return checked.filter((c) => c.allowed).map((c) => c.r);
}

/**
 * A mention of someone off the nest (PEOPLE_SUGGEST_ALL_USERS) doubles as a
 * read invite — but only from a write+ author: commenting is read-tier, and a
 * read-only reviewer must not be able to grant access by tagging. Otherwise
 * the outsider stays off the nest and canOpenNode drops them as before.
 *
 * A raw insert, not addCollaborator: that path also emails and channel-posts
 * "added as read", and the mention is about to notify the same person itself.
 */
async function inviteMentioned(
  nestId: string,
  actorEmail: string,
  outsiders: Recipient[],
): Promise<void> {
  const db = getDb();
  const actor = (await db.get("SELECT id FROM users WHERE LOWER(email) = LOWER(?)", [
    actorEmail,
  ])) as { id: string } | undefined;
  if (!actor) return;
  const access = await resolveNestAccess(nestId, actor.id);
  if (permissionLevel(access.permission) < permissionLevel("write")) return;
  // No unique index on (nest_id, user_id): the NOT EXISTS keeps two mentions
  // racing on the same outsider from leaving two rows, which DELETE by row id
  // would then only half-remove.
  for (const r of outsiders) {
    await db.run(
      `INSERT INTO nest_collaborators (id, nest_id, user_id, permission, granted_by)
       SELECT ?, ?, ?, 'read', ?
        WHERE NOT EXISTS (SELECT 1 FROM nest_collaborators WHERE nest_id = ? AND user_id = ?)`,
      [uuid(), nestId, r.userId, actor.id, nestId, r.userId],
    );
  }
}

/** Inbox row per recipient. `subject_id` is the node id: listNotifications
 *  resolves a 'mention' row's document straight from it (there is no request
 *  row to join), so the queue entry links to the document. */
async function insertInboxRows(params: {
  nestId: string;
  nodeId: string;
  recipients: Recipient[];
  message: string;
  /** 'mention' (named in the text), 'comment_reply' (a thread you're in) or
   *  'comment' (a document you watch or review). */
  kind?: "mention" | "comment_reply" | "comment";
  /** Who wrote the text — the sender in the message log. */
  actorEmail?: string;
}): Promise<number> {
  const now = new Date().toISOString();
  let created = 0;
  for (const r of params.recipients) {
    await insertNotification(
      {
        nestId: params.nestId,
        userEmail: r.email,
        kind: params.kind ?? "mention",
        subjectId: params.nodeId,
        message: params.message,
        createdAt: now,
      },
      { from: params.actorEmail, nodeId: params.nodeId },
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
 * mention is addressed to one human, and only someone who can open the document
 * gets one. The connector message is the team-channel half, so it is written in
 * the third person and names its recipients — but carries no comment text: a
 * channel's audience is configured per nest, not derived from who can read the
 * document, and commenting is deliberately read-tier. Titles and actor emails
 * it already receives for every review event; arbitrary comment prose it does
 * not, and a mention is a poor place to start.
 */
async function deliverMentionMessages(params: {
  nestId: string;
  nodeId: string;
  recipients: Recipient[];
  /** What the event is, in the third person — a connector posts to a channel,
   *  where the inbox row's "mentioned you" would address the wrong reader. */
  channelMessage: string;
  actorEmail: string;
  excerpt: string;
  ctx: { docTitle: string; path: string; link: string };
}): Promise<void> {
  const { nestId, nodeId, recipients, channelMessage, actorEmail, excerpt, ctx } =
    params;
  let throttled = 0;
  // Asked before the token is spent: on a nest with no connector there is
  // nothing to post, so charging the channel budget would bill a no-op and
  // then warn about "skipped" messages that had nowhere to go.
  const channelReachable = await hasAnyConnector(nestId, "mention");
  if (channelReachable && canDeliver("channel", nestId, actorEmail)) {
    void dispatchEvent({
      kind: "mention",
      nestId,
      subjectId: nodeId,
      actor: actorEmail,
      message: channelMessage,
    });
  } else if (channelReachable) {
    throttled++;
  }
  // Same rule as the channel: no SMTP means no email to ration.
  for (const r of isEmailConfigured() ? recipients : []) {
    if (!canDeliver("email", nestId, actorEmail)) {
      throttled++;
      continue;
    }
    void sendEmailToRecipient(r.email, {
      status: "mention",
      docTitle: ctx.docTitle,
      path: ctx.path,
      link: ctx.link,
      actor: actorEmail,
      note: excerpt || null,
    });
  }
  if (throttled > 0) {
    // Logged, not silent: the inbox rows landed, so nobody lost the mention —
    // but an operator seeing this repeatedly is looking at someone hammering
    // the fan-out, which is worth knowing.
    console.warn(
      `[notify] mention delivery budget exhausted for ${actorEmail} in ${nestId} — ${throttled} outbound message(s) skipped; inbox rows unaffected`,
    );
  }
}

/**
 * Outbound mention deliveries one person may cause in one nest per window.
 *
 * MAX_MENTION_RECIPIENTS bounds a single comment; this bounds the stream of
 * them. Commenting is read-tier and unthrottled — deliberately, so a reviewer
 * can comment freely — which before this feature cost nothing, because a
 * comment had no side effects worth abusing. Now each one can send mail and
 * post to a team channel, so a read-tier caller looping comments is an
 * amplifier with no ceiling.
 *
 * Budgeted here rather than on comment creation, and that placement is the
 * whole design: throttling the WRITE would break a legitimate agent working
 * through a review, posting a comment per finding (which context_comment now
 * makes ordinary). So the comment always lands, and the inbox row always
 * lands — the queue is the recipient's own record, it is local, and it costs
 * one insert. Only the EXTERNAL fan-out is rationed: one token per email and
 * one per connector post, the parts that leave the server.
 *
 * A budget this size is invisible to a person tagging colleagues all day and
 * caps a loop at tens of messages instead of thousands.
 */
export const MENTION_DELIVERY_BUDGET = { max: 50, windowMs: 5 * 60_000 };

/**
 * The channel post draws on its OWN budget rather than the email one.
 *
 * They are different shapes of cost: emails scale with the number of people
 * named, the channel post is one message per comment however many were named.
 * Sharing a pool also made the email allowance depend on something invisible —
 * dispatchEvent is a no-op on a nest with no connector configured, but the
 * token was spent before it could say so, quietly halving the documented email
 * budget on the deployments least likely to have a connector at all.
 */
const MENTION_CHANNEL_BUDGET = { max: 25, windowMs: 5 * 60_000 };

/**
 * True while this actor still has outbound budget of this kind in this nest.
 *
 * Keyed per NEST, not globally per actor: a nest is the unit of collaboration,
 * and a heavy day in one shouldn't ration a mention in another. Spreading a
 * burst across nests does multiply the total — but only across nests the actor
 * already has access to, which is separately gated, and each nest's own
 * audience stays bounded, which is what the budget is protecting.
 */
function canDeliver(
  kind: "email" | "channel",
  nestId: string,
  actorEmail: string,
): boolean {
  return tryConsume(
    `mention-${kind}:${nestId}:${actorEmail.toLowerCase()}`,
    kind === "email" ? MENTION_DELIVERY_BUDGET : MENTION_CHANNEL_BUDGET,
  );
}

/** "X mentioned A and B in *Doc*" — the channel's third-person form of the
 *  same event each recipient reads as "X mentioned you in …". */
function channelSentence(
  actorEmail: string,
  recipients: Recipient[],
  /** Where it happened, as the rest of the sentence: `in *Doc*`, or
   *  `in a comment on *Doc*`. */
  where: string,
): string {
  const names = recipients.map((r) => r.email).join(", ");
  return `${actorEmail} mentioned ${names} ${where}`;
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
    const names = newMentions(previousBody, nextBody);
    const recipients = await resolveRecipients({ nestId, nodeId, names, actorEmail });
    if (recipients.length === 0) return 0;

    const ctx = await buildDocContext(nestId, nodeId, baseUrl);
    const message = `${actorEmail} mentioned you in "${ctx.label}"`;
    const created = await insertInboxRows({ nestId, nodeId, recipients, message, actorEmail });
    await deliverMentionMessages({
      nestId,
      nodeId,
      recipients,
      channelMessage: channelSentence(
        actorEmail,
        recipients,
        `in *${ctx.label}*`,
      ),
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
  return (await commentMentionFanOut(params)).length;
}

/** notifyCommentMentions' body, returning WHO was notified so a reply can
 *  leave those people out of its participant fan-out. */
async function commentMentionFanOut(params: {
  nestId: string;
  nodeId: string;
  body: string;
  actorEmail: string;
  baseUrl?: string;
}): Promise<Recipient[]> {
  const { nestId, nodeId, body, actorEmail, baseUrl } = params;
  try {
    const names = extractMentions(body || "");
    const recipients = await resolveRecipients({ nestId, nodeId, names, actorEmail });
    if (recipients.length === 0) return [];

    const ctx = await buildDocContext(nestId, nodeId, baseUrl);
    const excerpt = excerptOf(body);
    const message = `${actorEmail} mentioned you in a comment on "${ctx.label}"`;
    await insertInboxRows({ nestId, nodeId, recipients, message, actorEmail });
    await deliverMentionMessages({
      nestId,
      nodeId,
      recipients,
      channelMessage: channelSentence(
        actorEmail,
        recipients,
        `in a comment on *${ctx.label}*`,
      ),
      actorEmail,
      excerpt,
      ctx,
    });
    return recipients;
  } catch (err) {
    console.error("[notify] comment mention fan-out failed", nestId, nodeId, err);
    return [];
  }
}

/**
 * A reply on a comment thread: the @mentions in it notify exactly as
 * notifyCommentMentions does, and everyone who already took part in the
 * thread (its opener and every earlier replier) hears about the reply too —
 * otherwise a question answered in a thread reaches nobody unless the
 * replier remembered to tag the asker.
 *
 * A participant is skipped when they are the replier, or when this same
 * reply already notified them through an @mention (one event, one row). The
 * same open-the-document check and recipient cap apply as for a mention.
 *
 * Inbox row (kind 'comment_reply', linking the document) + a direct email
 * when SMTP is configured, drawing on the same per-actor email budget as
 * mentions. No team-channel post: a reply is addressed to the people in the
 * thread, and posting every reply to the nest's channel (including the
 * server-wide webhook) would be noise the channel never asked for.
 */
export async function notifyCommentReply(params: {
  nestId: string;
  nodeId: string;
  /** The thread AFTER the reply was added — its opener and comment authors
   *  are the participants. */
  thread: { createdBy: string; comments: Array<{ author: string }> };
  body: string;
  /** Who wrote the reply. */
  actorEmail: string;
  baseUrl?: string;
}): Promise<{ mentioned: number; participants: number }> {
  const mentioned = await commentMentionFanOut(params);
  const participants = await notifyThreadParticipants({
    ...params,
    exclude: mentioned.map((r) => r.email),
  });
  return { mentioned: mentioned.length, participants: participants.length };
}

/** notifyCommentReply's participant fan-out, returning WHO was notified so
 *  notifyComment can keep its follower fan-out from pinging them again. */
async function notifyThreadParticipants(params: {
  nestId: string;
  nodeId: string;
  thread: { createdBy: string; comments: Array<{ author: string }> };
  body: string;
  actorEmail: string;
  baseUrl?: string;
  exclude: string[];
}): Promise<Recipient[]> {
  const { nestId, nodeId, thread, body, actorEmail, baseUrl } = params;
  try {
    const skip = new Set<string>(
      [actorEmail, ...params.exclude].map((e) => e.toLowerCase()),
    );
    const emails: string[] = [];
    for (const e of [thread.createdBy, ...thread.comments.map((c) => c.author)]) {
      const key = (e || "").toLowerCase();
      if (!key || skip.has(key)) continue;
      skip.add(key);
      emails.push(key);
      if (emails.length >= MAX_MENTION_RECIPIENTS) break;
    }
    if (emails.length === 0) return [];

    const db = getDb();
    const candidates: Recipient[] = [];
    for (const email of emails) {
      // No account means no inbox (e.g. an anonymous OPEN-mode author).
      const user = (await db.get(
        "SELECT id, email FROM users WHERE LOWER(email) = LOWER(?)",
        [email],
      )) as { id: string; email: string } | undefined;
      if (user) candidates.push({ email: user.email, userId: user.id });
    }
    // Someone who has since lost access to the document hears nothing about
    // it — the same rule a mention keeps.
    const checked = await Promise.all(
      candidates.map(async (r) => ({
        r,
        allowed: await canOpenNode(nestId, nodeId, r.userId, r.email),
      })),
    );
    const recipients = checked.filter((c) => c.allowed).map((c) => c.r);
    if (recipients.length === 0) return [];

    const ctx = await buildDocContext(nestId, nodeId, baseUrl);
    const excerpt = excerptOf(body);
    const message = `${actorEmail} replied to a comment thread on "${ctx.label}"`;
    await insertInboxRows({
      nestId,
      nodeId,
      recipients,
      message,
      kind: "comment_reply",
      actorEmail,
    });
    let throttled = 0;
    for (const r of isEmailConfigured() ? recipients : []) {
      if (!canDeliver("email", nestId, actorEmail)) {
        throttled++;
        continue;
      }
      void sendEmailToRecipient(r.email, {
        status: "comment_reply",
        docTitle: ctx.docTitle,
        path: ctx.path,
        link: ctx.link,
        actor: actorEmail,
        note: excerpt || null,
      });
    }
    if (throttled > 0) {
      console.warn(
        `[notify] reply delivery budget exhausted for ${actorEmail} in ${nestId} — ${throttled} email(s) skipped; inbox rows unaffected`,
      );
    }
    return recipients;
  } catch (err) {
    console.error("[notify] comment reply fan-out failed", nestId, nodeId, err);
    return [];
  }
}

/**
 * Upper bound on watcher + reviewer recipients one comment can reach. Both
 * lists are admin-curated, so this is a backstop, not a policy: it bounds the
 * inbox rows and emails a single read-tier write can cause.
 */
export const MAX_COMMENT_FOLLOWERS = 50;

/**
 * Everything a new comment notifies: the people named in it (mentions, as
 * before) AND the people who follow the document — its watchers and its
 * reviewer stewards (document, tag and nest scope).
 *
 * Followers get a plain "X commented on Doc" row (kind `comment`) and, with
 * SMTP configured, an email carrying the excerpt. Never the comment's author,
 * never someone the comment already reached as a mention (one comment, one
 * notification each), never anyone who can't open the document, never an
 * address with no account.
 *
 * No team-channel post: a comment is read-tier and frequent, and the channel
 * rule above (no comment prose to a channel whose audience isn't derived from
 * who can read the document) applies to followers too. Outbound email draws
 * on the same per-actor budget mentions do.
 *
 * Best-effort like every fan-out: never throws, never fails the comment.
 */
export async function notifyComment(params: {
  nestId: string;
  nodeId: string;
  body: string;
  /** Who wrote the comment. */
  actorEmail: string;
  baseUrl?: string;
  /** Set for a reply: the thread AFTER the reply was added. Its participants
   *  hear about it first (kind 'comment_reply', as notifyCommentReply). */
  thread?: { createdBy: string; comments: Array<{ author: string }> };
}): Promise<{ mentioned: number; participants: number; followers: number }> {
  const mentioned = await commentMentionFanOut(params);
  const reached = mentioned.map((r) => r.email);
  const participants = params.thread
    ? await notifyThreadParticipants({ ...params, thread: params.thread, exclude: reached })
    : [];
  const followers = await notifyCommentFollowers({
    ...params,
    exclude: [...reached, ...participants.map((r) => r.email)],
  });
  return { mentioned: mentioned.length, participants: participants.length, followers };
}

async function notifyCommentFollowers(params: {
  nestId: string;
  nodeId: string;
  body: string;
  actorEmail: string;
  baseUrl?: string;
  exclude: string[];
}): Promise<number> {
  const { nestId, nodeId, body, actorEmail, baseUrl } = params;
  try {
    const skip = new Set(
      [actorEmail, ...params.exclude].map((e) => e.toLowerCase()),
    );
    const [watchers, stewards] = await Promise.all([
      listWatchers(nestId, nodeId),
      resolveStewardsForNode(nestId, nodeId),
    ]);
    const emails: string[] = [];
    for (const e of [
      ...watchers.map((w) => w.user_email),
      ...stewards
        .filter((s) => s.steward.role === "reviewer")
        .map((s) => s.steward.userEmail),
    ]) {
      const key = e.toLowerCase();
      if (skip.has(key)) continue;
      skip.add(key);
      emails.push(key);
      if (emails.length >= MAX_COMMENT_FOLLOWERS) break;
    }
    if (emails.length === 0) return 0;

    // Account lookup in one read: a watcher or steward invited by email who
    // never signed up has no inbox to read.
    const users = (await getDb().all(
      `SELECT id, LOWER(email) AS email FROM users
        WHERE LOWER(email) IN (${emails.map(() => "?").join(",")})`,
      emails,
    )) as Array<{ id: string; email: string }>;
    const byEmail = new Map(users.map((u) => [u.email, u.id]));
    const candidates: Recipient[] = emails
      .filter((e) => byEmail.has(e))
      .map((e) => ({ email: e, userId: byEmail.get(e)! }));

    // A watcher row outlives the access that justified it; check access now.
    const checked = await Promise.all(
      candidates.map(async (r) => ({
        r,
        allowed: await canOpenNode(nestId, nodeId, r.userId, r.email),
      })),
    );
    const recipients = checked.filter((c) => c.allowed).map((c) => c.r);
    if (recipients.length === 0) return 0;

    const ctx = await buildDocContext(nestId, nodeId, baseUrl);
    // subject_id is the node id, as for a mention: listNotifications links
    // a 'comment' row straight to the document.
    await insertInboxRows({
      nestId,
      nodeId,
      recipients,
      message: `${actorEmail} commented on "${ctx.label}"`,
      kind: "comment",
    });

    let throttled = 0;
    const excerpt = excerptOf(body);
    for (const r of isEmailConfigured() ? recipients : []) {
      if (!canDeliver("email", nestId, actorEmail)) {
        throttled++;
        continue;
      }
      void sendEmailToRecipient(r.email, {
        status: "comment",
        docTitle: ctx.docTitle,
        path: ctx.path,
        link: ctx.link,
        actor: actorEmail,
        note: excerpt || null,
      });
    }
    if (throttled > 0) {
      console.warn(
        `[notify] comment delivery budget exhausted for ${actorEmail} in ${nestId} — ${throttled} email(s) skipped; inbox rows unaffected`,
      );
    }
    return recipients.length;
  } catch (err) {
    console.error("[notify] comment follower fan-out failed", nestId, nodeId, err);
    return 0;
  }
}
