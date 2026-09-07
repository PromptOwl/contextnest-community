/**
 * Mention notifications — tell someone their name came up in a document.
 *
 * Its own module rather than part of notify-service: resolving a mention needs
 * the nest's people, and that lookup sits on the teams-service →
 * notify-service import chain.
 *
 * Best-effort by the same contract the rest of the fan-outs keep: a
 * notification failure must never fail the save that triggered it.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { listNestPeople } from "../nests/people-service.js";
import { newMentions, resolveMention } from "../shared/mentions.js";
import { describeNode } from "./title-resolver.js";
import { canReadNode } from "./access-guard.js";

/**
 * Drop an inbox row for everyone newly mentioned in a document body.
 *
 * Only NEW mentions notify: the same `@name` surviving a dozen saves is one
 * event, not a dozen. Recipients are resolved against the nest's people, so a
 * name that matches nobody notifies nobody — the editor already draws it as
 * unresolved. The author never hears about their own mention, and a mention
 * only reaches someone who can actually open the document, so a notification
 * can't tell a reader about a document (or a title) they have no access to.
 */
export async function notifyMentions(params: {
  nestId: string;
  nodeId: string;
  /** Body before this save; "" for a document being created. */
  previousBody: string;
  nextBody: string;
  /** Who wrote the mention. */
  actorEmail: string;
}): Promise<number> {
  const { nestId, nodeId, previousBody, nextBody, actorEmail } = params;
  try {
    const names = newMentions(previousBody, nextBody);
    if (names.length === 0) return 0;

    const people = await listNestPeople(nestId);
    const actor = actorEmail.toLowerCase();
    const recipients = new Map<string, { email: string; userId: string }>();
    for (const name of names) {
      const person = resolveMention(people, name);
      // No account means no inbox to read — a steward invited by email who
      // never signed up hears about it when they're actually a user.
      if (!person?.userId) continue;
      const key = person.email.toLowerCase();
      if (key === actor || recipients.has(key)) continue;
      recipients.set(key, { email: person.email, userId: person.userId });
    }
    if (recipients.size === 0) return 0;

    const label = await describeNode(nestId, nodeId);
    const now = new Date().toISOString();
    const db = getDb();
    let created = 0;
    for (const { email, userId } of recipients.values()) {
      if (!(await canReadNode(nestId, nodeId, userId, email))) continue;
      await db.run(
        `INSERT INTO notifications (id, nest_id, user_email, kind, subject_id, message, created_at)
         VALUES (?, ?, ?, 'mention', ?, ?, ?)`,
        [
          uuid(),
          nestId,
          email.toLowerCase(),
          nodeId,
          `${actorEmail} mentioned you in "${label}"`,
          now,
        ],
      );
      created++;
    }
    return created;
  } catch (err) {
    console.error("[notify] mention fan-out failed", nestId, nodeId, err);
    return 0;
  }
}
