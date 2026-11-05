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

/** How an inbox message names a person: their display name, else the email. */
export async function personLabel(email: string): Promise<string> {
  const row = (await getDb().get(
    "SELECT name FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
    [email],
  )) as { name: string | null } | undefined;
  return row?.name?.trim() || email;
}

export async function insertNotification(
  row: InboxRow,
  ctx: OutboundContext & { from?: string | null } = {},
): Promise<void> {
  const email = row.userEmail.toLowerCase();
  // A sealed personal nest notifies its owner only (re-review R3-H1a).
  if (row.nestId) {
    const { sealedNest } = await import("../surfaces/sealed.js");
    const sealed = await sealedNest(row.nestId);
    if (sealed && sealed.ownerEmail.toLowerCase() !== email) return;
  }
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
