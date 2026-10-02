/**
 * HITL notify — "tag a person to a node, they hear about its activity."
 *
 * A watcher row ties an email to a node (usually an agent, sometimes a
 * document). When a review request lands for a document, we notify:
 *   - watchers of that document, and
 *   - watchers of any agent with a flow edge INTO that document — tagging
 *     the agent means "tell me when its output needs review".
 *
 * Notifications are rows, surfaced via /me/work. A Slack/webhook connector
 * can drain the same table later — the schema doesn't change.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { describeNode } from "./title-resolver.js";
import { permissionLabel } from "./roles.js";
import { notifyNestEvent } from "../notify/notify.js";

export interface Watcher {
  id: string;
  node_id: string;
  user_email: string;
  created_by: string;
  created_at: string;
}

export async function listWatchers(
  nestId: string,
  nodeId: string,
): Promise<Watcher[]> {
  return (await getDb().all(
    `SELECT id, node_id, user_email, created_by, created_at
       FROM watchers WHERE nest_id = ? AND node_id = ? ORDER BY created_at`,
    [nestId, nodeId],
  )) as Watcher[];
}

export async function addWatcher(
  nestId: string,
  nodeId: string,
  userEmail: string,
  createdBy: string,
): Promise<void> {
  await getDb().run(
    `INSERT INTO watchers (id, nest_id, node_id, user_email, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(nest_id, node_id, user_email) DO NOTHING`,
    [uuid(), nestId, nodeId, userEmail.toLowerCase(), createdBy, new Date().toISOString()],
  );
}

export async function removeWatcher(
  nestId: string,
  nodeId: string,
  userEmail: string,
): Promise<boolean> {
  const db = getDb();
  const row = await db.get(
    "SELECT id FROM watchers WHERE nest_id = ? AND node_id = ? AND LOWER(user_email) = LOWER(?)",
    [nestId, nodeId, userEmail],
  );
  if (!row) return false;
  await db.run("DELETE FROM watchers WHERE id = ?", [(row as { id: string }).id]);
  return true;
}

/**
 * Fan a review-request event out to watchers. Called from submitForReview —
 * best-effort by contract: a notification failure must never fail the review.
 */
export async function notifyReviewRequested(params: {
  nestId: string;
  nodeId: string;
  requestedBy: string;
  reviewId: string;
}): Promise<number> {
  const { nestId, nodeId, requestedBy, reviewId } = params;
  const db = getDb();
  try {
    // Watchers of the document itself + watchers of agents that flow into it.
    const rows = (await db.all(
      `SELECT DISTINCT w.user_email, w.node_id AS via
         FROM watchers w
        WHERE w.nest_id = ?
          AND (w.node_id = ?
               OR w.node_id IN (
                 SELECT e.from_node FROM edges e
                   JOIN edge_types t ON t.id = e.type_id
                  WHERE e.nest_id = ? AND e.to_node = ? AND t.is_flow = 1
               ))`,
      [nestId, nodeId, nestId, nodeId],
    )) as Array<{ user_email: string; via: string }>;

    const now = new Date().toISOString();
    // Human title, not the storage id — an inbox row reading
    // "nodes/content/blog-viewable-second-brain" leaks the path at the user.
    const label = await describeNode(nestId, nodeId);
    let created = 0;
    for (const r of rows) {
      // Don't notify someone about their own submission.
      if (r.user_email.toLowerCase() === requestedBy.toLowerCase()) continue;
      await db.run(
        `INSERT INTO notifications (id, nest_id, user_email, kind, subject_id, message, created_at)
         VALUES (?, ?, ?, 'review_requested', ?, ?, ?)`,
        [
          uuid(),
          nestId,
          r.user_email.toLowerCase(),
          reviewId,
          r.via === nodeId
            ? `"${label}" has a new version awaiting review (submitted by ${requestedBy})`
            : `Agent "${await describeNode(nestId, r.via)}" produced output on "${label}" — awaiting review`,
          now,
        ],
      );
      created++;
    }
    return created;
  } catch (err) {
    console.error("[notify] review fan-out failed", nestId, nodeId, err);
    return 0;
  }
}

/**
 * Fan a HELD AGENT WRITE (Push Confirmation Gate) out to the people who can confirm
 * it: the nest owner and every active reviewer steward. Best-effort by
 * contract — a notify failure must never fail the hold.
 */
export async function notifyPendingPush(params: {
  nestId: string;
  pendingId: string;
  submitterEmail: string;
  submitterLabel: string;
  docCount: number;
}): Promise<number> {
  const { nestId, pendingId, submitterEmail, submitterLabel, docCount } = params;
  const db = getDb();
  try {
    const nest = (await db.get(
      `SELECT n.name AS name, u.email AS owner_email
         FROM nests n JOIN users u ON u.id = n.user_id
        WHERE n.id = ?`,
      [nestId],
    )) as { name?: string; owner_email?: string } | undefined;

    const reviewers = (await db.all(
      `SELECT DISTINCT LOWER(user_email) AS email
         FROM stewards
        WHERE nest_id = ? AND role = 'reviewer' AND is_active = 1`,
      [nestId],
    )) as Array<{ email: string }>;

    const recipients = new Set<string>(reviewers.map((r) => r.email));
    if (nest?.owner_email) recipients.add(nest.owner_email.toLowerCase());
    // The submitter already knows what it wrote.
    recipients.delete(submitterEmail.toLowerCase());

    const now = new Date().toISOString();
    const nestName = nest?.name ?? nestId;
    let created = 0;
    for (const email of recipients) {
      await db.run(
        `INSERT INTO notifications (id, nest_id, user_email, kind, subject_id, message, created_at)
         VALUES (?, ?, ?, 'pending_push', ?, ?, ?)`,
        [
          uuid(),
          nestId,
          email,
          pendingId,
          `${submitterLabel} wrote ${docCount} document(s) to "${nestName}" — awaiting your confirmation`,
          now,
        ],
      );
      created++;
    }

    // Slack/Teams/email connector line (best-effort, debounced).
    await notifyNestEvent(
      nestId,
      `📥 Agent write held for confirmation on "${nestName}": ${docCount} document(s) from ${submitterLabel} (${submitterEmail}).`,
    );

    return created;
  } catch (err) {
    console.error("[notify] pending-push fan-out failed", nestId, err);
    return 0;
  }
}

/**
 * Fan a review RESOLUTION out: the submitter always hears the verdict; node
 * + upstream-agent watchers hear it too. Best-effort like the request side.
 */
export async function notifyReviewResolved(params: {
  nestId: string;
  nodeId: string;
  status: "approved" | "rejected";
  resolvedBy: string;
  requestedBy: string;
  reviewId: string;
}): Promise<number> {
  const { nestId, nodeId, status, resolvedBy, requestedBy, reviewId } = params;
  const db = getDb();
  try {
    const rows = (await db.all(
      `SELECT DISTINCT w.user_email
         FROM watchers w
        WHERE w.nest_id = ?
          AND (w.node_id = ?
               OR w.node_id IN (
                 SELECT e.from_node FROM edges e
                   JOIN edge_types t ON t.id = e.type_id
                  WHERE e.nest_id = ? AND e.to_node = ? AND t.is_flow = 1
               ))`,
      [nestId, nodeId, nestId, nodeId],
    )) as Array<{ user_email: string }>;

    const recipients = new Set(rows.map((r) => r.user_email.toLowerCase()));
    recipients.add(requestedBy.toLowerCase()); // verdicts always reach the submitter
    recipients.delete(resolvedBy.toLowerCase()); // not the person who clicked

    const now = new Date().toISOString();
    const label = await describeNode(nestId, nodeId);
    let created = 0;
    for (const email of recipients) {
      await db.run(
        `INSERT INTO notifications (id, nest_id, user_email, kind, subject_id, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          uuid(),
          nestId,
          email,
          `review_${status}`,
          reviewId,
          `"${label}" was ${status} by ${resolvedBy}`,
          now,
        ],
      );
      created++;
    }
    return created;
  } catch (err) {
    console.error("[notify] resolution fan-out failed", nestId, nodeId, err);
    return 0;
  }
}

/**
 * Drop a Hootie inbox row for a fresh nest invite, so being added to a nest
 * shows up in /me/work alongside review requests — the same human-in-the-loop
 * surface. Best-effort by contract: a failure here must never fail the invite.
 */
export async function notifyNestInvite(params: {
  nestId: string;
  inviteeEmail: string;
  permission: string;
  nestName: string;
  /** Team the access came through, when it wasn't granted to the person directly. */
  viaTeam?: string;
}): Promise<void> {
  const { nestId, inviteeEmail, permission, nestName, viaTeam } = params;
  const message = viaTeam
    ? `Your team "${viaTeam}" was given access to "${nestName}" as ${permissionLabel(permission)}`
    : `You were added to "${nestName}" as ${permissionLabel(permission)}`;
  try {
    await getDb().run(
      `INSERT INTO notifications (id, nest_id, user_email, kind, subject_id, message, created_at)
       VALUES (?, ?, ?, 'nest_invite', ?, ?, ?)`,
      [
        uuid(),
        nestId,
        inviteeEmail.toLowerCase(),
        nestId,
        message,
        new Date().toISOString(),
      ],
    );
  } catch (err) {
    console.error("[notify] invite inbox insert failed", nestId, inviteeEmail, err);
  }
}

export interface Notification {
  id: string;
  nest_id: string;
  kind: string;
  subject_id: string | null;
  message: string;
  created_at: string;
  read_at: string | null;
  /** Document the row is about, when there is one — the inbox links to it. */
  node_id: string | null;
  /** The nest's display name, so the inbox can navigate without a nest list. */
  nest_name: string;
}

export async function listNotifications(
  userEmail: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<Notification[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  // subject_id is a review or deletion-request id, not a node id, so the
  // document comes from those tables — resolved in the same read rather than
  // a second round of lookups. Folder/nest deletions have no document to open.
  return (await getDb().all(
    `SELECT n.id, n.nest_id, n.kind, n.subject_id, n.message, n.created_at, n.read_at,
            COALESCE(
              rr.node_id,
              CASE WHEN dr.target_type = 'document' THEN dr.node_id END,
              -- A mention names the document directly; there's no request row.
              CASE WHEN n.kind IN ('mention', 'comment') THEN n.subject_id END
            ) AS node_id,
            -- Name resolved here so the inbox never fetches the nest list for it.
            COALESCE(ns.name, n.nest_id) AS nest_name
       FROM notifications n
       LEFT JOIN nests ns ON ns.id = n.nest_id
       LEFT JOIN review_requests rr ON rr.id = n.subject_id
       LEFT JOIN deletion_requests dr ON dr.id = n.subject_id
      WHERE LOWER(n.user_email) = LOWER(?)${opts.unreadOnly ? " AND n.read_at IS NULL" : ""}
      ORDER BY n.created_at DESC LIMIT ${limit}`,
    [userEmail],
  )) as Notification[];
}

export async function markNotificationsRead(
  userEmail: string,
  ids: string[] | "all",
): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  if (ids === "all") {
    await db.run(
      "UPDATE notifications SET read_at = ? WHERE LOWER(user_email) = LOWER(?) AND read_at IS NULL",
      [now, userEmail],
    );
    return;
  }
  for (const id of ids.slice(0, 200)) {
    await db.run(
      "UPDATE notifications SET read_at = ? WHERE id = ? AND LOWER(user_email) = LOWER(?)",
      [now, id, userEmail],
    );
  }
}

/**
 * Once a request (review or deletion/archive) is resolved, the "X was
 * requested" inbox row it produced is no longer actionable — but nothing
 * else ever marks it read, so it sits in every recipient's /me/work list
 * looking exactly like a still-open ask (CU: reviewer declines an archive
 * request, the original "requested" notification stays unread forever).
 * `subjectId` is the review/deletion request's own id, which is exactly
 * what those rows were inserted with — not the resolved kind, so a stale
 * "requested" row is cleared for every recipient regardless of who acted.
 */
export async function markNotificationsReadBySubject(
  subjectId: string,
  kind: string,
): Promise<void> {
  await getDb().run(
    "UPDATE notifications SET read_at = ? WHERE subject_id = ? AND kind = ? AND read_at IS NULL",
    [new Date().toISOString(), subjectId, kind],
  );
}
