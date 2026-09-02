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
              CASE WHEN dr.target_type = 'document' THEN dr.node_id END
            ) AS node_id
       FROM notifications n
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
