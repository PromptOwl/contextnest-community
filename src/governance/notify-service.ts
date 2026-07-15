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
            ? `"${nodeId}" has a new version awaiting review (submitted by ${requestedBy})`
            : `Agent "${r.via}" produced output on "${nodeId}" — awaiting review`,
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
          `"${nodeId}" was ${status} by ${resolvedBy}`,
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

export interface Notification {
  id: string;
  nest_id: string;
  kind: string;
  subject_id: string | null;
  message: string;
  created_at: string;
  read_at: string | null;
}

export async function listNotifications(
  userEmail: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<Notification[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  return (await getDb().all(
    `SELECT id, nest_id, kind, subject_id, message, created_at, read_at
       FROM notifications
      WHERE LOWER(user_email) = LOWER(?)${opts.unreadOnly ? " AND read_at IS NULL" : ""}
      ORDER BY created_at DESC LIMIT ${limit}`,
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
