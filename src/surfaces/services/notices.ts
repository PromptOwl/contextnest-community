/**
 * Surfaces notices: admin alerts (guard pauses, disowned links) and user
 * notices (out-of-band "your account was linked" email). Each is a
 * surface_notices row — counts and kinds only, never names or message text —
 * plus a best-effort email through the server's existing transport. A send
 * failure never fails the action that raised the notice.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../../db/client.js";
import { isLicenseAdminEmail } from "../../auth/license.js";
import { isSuperAdmin } from "../../governance/access-service.js";
import { sendEmailToRecipient } from "../../notify/email.js";
import { ORG_ID } from "../flags.js";

export interface NoticeInput {
  kind: string;
  audience: "admins" | "user";
  recipientUserId?: string | null;
  bindingId?: string | null;
  nestId?: string | null;
  /** Counts/kinds only. */
  detail?: Record<string, unknown>;
  /** Plain subject + text for the email (no names of other people, no message text). */
  subject: string;
  text: string;
  /** Explicit recipients (e.g. a nest's admins) instead of the audience default. */
  to?: string[];
}

/** Every server admin (license admin + superadmins): the org admins here. */
export async function serverAdminUsers(): Promise<Array<{ id: string; email: string }>> {
  const rows = (await getDb().all("SELECT id, email FROM users WHERE COALESCE(is_service, 0) = 0")) as Array<{ id: string; email: string }>;
  return rows.filter((r) => !!r.email && (isLicenseAdminEmail(r.email) || isSuperAdmin(r.email)));
}

export async function recordNotice(n: NoticeInput): Promise<string> {
  const id = uuid();
  let to: string[] = [];
  if (n.to) {
    to = n.to.filter((e) => typeof e === "string" && e.includes("@"));
  } else if (n.audience === "user" && n.recipientUserId) {
    const u = (await getDb().get("SELECT email FROM users WHERE id = ?", [n.recipientUserId])) as { email?: string } | undefined;
    if (u?.email) to = [u.email];
  } else if (n.audience === "admins") {
    to = (await serverAdminUsers()).map((a) => a.email);
  }
  let outcome: string = "none";
  if (to.length) {
    try {
      outcome = await sendEmailToRecipient(
        to,
        { status: "agent_notify", docTitle: n.subject, path: "Surfaces", actor: "ContextNest Surfaces", note: n.text, link: "" },
        { senderKind: "system", senderId: null, noNest: true },
      );
    } catch {
      outcome = "failed";
    }
  }
  await getDb().run(
    `INSERT INTO surface_notices (id, org_id, kind, audience, recipient_user_id, binding_id, nest_id, detail, email_outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      ORG_ID,
      n.kind,
      n.audience,
      n.recipientUserId ?? null,
      n.bindingId ?? null,
      n.nestId ?? null,
      JSON.stringify(n.detail ?? {}),
      outcome,
      new Date().toISOString(),
    ],
  );
  return id;
}
