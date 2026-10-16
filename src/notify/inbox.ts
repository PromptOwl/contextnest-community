/**
 * In-app inbox writes. Every `notifications` row goes through here so the
 * message log sees each one (channel "inbox"). The INSERT keeps the exact
 * failure semantics callers had before — it throws on a DB error, and callers
 * that caught still catch — while the log write never throws.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { recordOutbound, senderFor, type OutboundContext } from "./outbound-log.js";

export interface InboxRow {
  nestId: string;
  userEmail: string;
  kind: string;
  subjectId: string;
  message: string;
  createdAt?: string;
}

export async function insertNotification(
  row: InboxRow,
  ctx: OutboundContext & { from?: string | null } = {},
): Promise<void> {
  const email = row.userEmail.toLowerCase();
  await getDb().run(
    `INSERT INTO notifications (id, nest_id, user_email, kind, subject_id, message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), row.nestId, email, row.kind, row.subjectId, row.message, row.createdAt ?? new Date().toISOString()],
  );
  const { from, ...rest } = ctx;
  await recordOutbound({
    channel: "inbox",
    ...senderFor(from),
    ...rest,
    nestId: rest.nestId ?? row.nestId,
    recipients: [email],
    subject: row.kind,
    body: row.message,
    status: "sent",
  });
}
