/**
 * Assignment notifications (CU-wdqcq03xn2): an inbox row for the person a
 * card was just assigned to, so it shows up in My Work like a mention does.
 * Best-effort by the same contract as the other fan-outs — a notification
 * failure never fails the save that assigned the card.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { insertNotification, personLabel } from "../notify/inbox.js";

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
    await insertNotification(
      {
        nestId,
        userEmail: assignee,
        kind: "assigned",
        subjectId: nodeId,
        message: `${await personLabel(actorEmail)} assigned you "${title}"`,
      },
      { from: actorEmail, nodeId },
    );
  } catch (err) {
    console.error("[notify] assignment inbox insert failed", nestId, nodeId, err);
  }
}
