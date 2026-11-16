/**
 * Who a metacognition agent's `notify` reaches (CU-wdqcq05rkq).
 *
 * The recipient keys come from the owner's saved config; this turns one key
 * into people at the moment of sending, and re-applies the membership rule
 * every time: a person removed from the nest after the config was saved is
 * not reachable any more, whatever the config still says. Service identities
 * (personas, access keys) are never people here — they have no mailbox, and
 * a persona must not be able to address another agent.
 */
import { getDb } from "../db/client.js";
import { listNestPeople } from "../nests/people-service.js";
import { resolveStewardsForNode } from "../governance/stewardship-service.js";
import { canOpenNode } from "../governance/mention-notify.js";

export interface NotifyPerson {
  email: string;
  userId: string;
  name: string | null;
}

/** Reviewers reached by one "reviewers" notification, at most. */
export const MAX_REVIEWER_RECIPIENTS = 10;

/**
 * The nest's people who can be notified: on the roster (owner, collaborators,
 * shared teams, stewards, grant holders), with a real (non-service) account.
 * Keyed by lower-cased email.
 */
export async function notifyMembers(nestId: string): Promise<Map<string, NotifyPerson>> {
  const roster = (await listNestPeople(nestId)).filter(
    (p): p is typeof p & { userId: string } => !!p.userId && !/\.invalid$/i.test(p.email.trim()),
  );
  const out = new Map<string, NotifyPerson>();
  if (!roster.length) return out;
  const db = getDb();
  const real = new Set<string>();
  for (let i = 0; i < roster.length; i += 500) {
    const chunk = roster.slice(i, i + 500);
    const rows = (await db.all(
      `SELECT id FROM users WHERE COALESCE(is_service, 0) = 0 AND id IN (${chunk.map(() => "?").join(",")})`,
      chunk.map((p) => p.userId),
    )) as Array<{ id: string }>;
    for (const r of rows) real.add(r.id);
  }
  for (const p of roster) {
    if (real.has(p.userId)) out.set(p.email.toLowerCase(), { email: p.email, userId: p.userId, name: p.name });
  }
  return out;
}

/** The people a configured key stands for right now, before the per-document check. */
async function candidates(nestId: string, key: string, nodeId: string | null, members: Map<string, NotifyPerson>): Promise<NotifyPerson[]> {
  if (key === "owner") {
    const row = (await getDb().get(
      "SELECT u.email FROM nests n JOIN users u ON u.id = n.user_id WHERE n.id = ?",
      [nestId],
    )) as { email: string } | undefined;
    const p = row ? members.get(row.email.toLowerCase()) : undefined;
    return p ? [p] : [];
  }
  if (key === "reviewers") {
    // The document's reviewer stewards when it names one, else the nest's.
    const emails = nodeId
      ? (await resolveStewardsForNode(nestId, nodeId))
          .filter((s) => s.steward.role === "reviewer")
          .map((s) => s.steward.userEmail)
      : (
          (await getDb().all(
            "SELECT user_email FROM stewards WHERE nest_id = ? AND is_active = 1 AND scope = 'nest' AND role = 'reviewer'",
            [nestId],
          )) as Array<{ user_email: string }>
        ).map((r) => r.user_email);
    const seen = new Set<string>();
    const out: NotifyPerson[] = [];
    for (const e of emails) {
      const p = members.get(e.toLowerCase());
      if (!p || seen.has(p.email.toLowerCase())) continue;
      seen.add(p.email.toLowerCase());
      out.push(p);
      if (out.length >= MAX_REVIEWER_RECIPIENTS) break;
    }
    return out;
  }
  const p = members.get(key.toLowerCase());
  return p ? [p] : [];
}

/**
 * Resolve a configured key to the people to notify now. Empty `people` comes
 * with the reason, worded for the model: nobody is reachable (no longer on
 * the nest, no reviewers), or nobody it reaches may open the document named.
 */
export async function resolveNotifyRecipients(
  nestId: string,
  key: string,
  nodeId: string | null,
  docs: string[],
): Promise<{ people: NotifyPerson[]; reason?: string }> {
  const members = await notifyMembers(nestId);
  const found = await candidates(nestId, key, nodeId, members);
  if (!found.length) {
    return {
      people: [],
      reason:
        key === "reviewers"
          ? "this nest has no reviewers you can notify"
          : `${key === "owner" ? "the nest owner" : key} is no longer a member of this nest`,
    };
  }
  if (!docs.length) return { people: found };
  // `docs` = the document named plus every one the run read: the note may
  // carry any of them, so only someone who can open them all hears it.
  const allowed: NotifyPerson[] = [];
  for (const p of found) {
    if (await canOpenAll(nestId, docs, p)) allowed.push(p);
  }
  return allowed.length
    ? { people: allowed }
    : { people: [], reason: `nobody in "${key}" can open every document this note is about or drew on (${docs.join(", ")})` };
}

async function canOpenAll(nestId: string, docs: string[], p: NotifyPerson): Promise<boolean> {
  for (const d of docs) if (!(await canOpenNode(nestId, d, p.userId, p.email))) return false;
  return true;
}

/** Past this many access checks (people × documents) the sweep isn't run and
 *  the answer is "too_many" (fail closed): a room post isn't worth an
 *  unbounded access check per notification. */
const OPEN_CHECK_MAX = 1000;

/**
 * Can everyone on the nest open all these documents? The bar for posting
 * about them to the nest's chat channel, whose audience isn't tied to theirs.
 */
export async function openToWholeNest(nestId: string, docs: string[]): Promise<"open" | "restricted" | "too_many"> {
  if (!docs.length) return "open";
  const members = [...(await notifyMembers(nestId)).values()];
  if (members.length * docs.length > OPEN_CHECK_MAX) return "too_many";
  for (const p of members) {
    if (!(await canOpenAll(nestId, docs, p))) return "restricted";
  }
  return "open";
}
