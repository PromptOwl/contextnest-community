/**
 * Assignment notifications (CU-wdqcq03xn2): an inbox row for the person a
 * card was just assigned to, so it shows up in My Work like a mention does.
 * Best-effort by the same contract as the other fan-outs — a notification
 * failure never fails the save that assigned the card.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";

export async function notifyAssigned(params: {
  nestId: string;
  nodeId: string;
  title: string;
  assignee: string;
  actorEmail: string;
}): Promise<void> {
  const { nestId, nodeId, title, assignee, actorEmail } = params;
  // Assigning yourself is not news.
  if (assignee.toLowerCase() === actorEmail.toLowerCase()) return;
  try {
    await getDb().run(
      `INSERT INTO notifications (id, nest_id, user_email, kind, subject_id, message, created_at)
       VALUES (?, ?, ?, 'assigned', ?, ?, ?)`,
      [
        uuid(),
        nestId,
        assignee.toLowerCase(),
        nodeId,
        `${actorEmail} assigned you "${title}"`,
        new Date().toISOString(),
      ],
    );
  } catch (err) {
    console.error("[notify] assignment inbox insert failed", nestId, nodeId, err);
  }
}
