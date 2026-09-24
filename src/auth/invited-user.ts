/**
 * The one way a person is added on someone else's behalf — Teammates invite,
 * nest share, team member, steward, document/folder grant, MCP. Creates the
 * invited account with a real temporary password and emails it to them with a
 * sign-in link, so every path leaves the new person a way in.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { normalizeEmail } from "../shared/email.js";
import { sendEmailToRecipient } from "../notify/email.js";
import { hashPassword } from "./keys.js";

interface InviteOpts {
  /** Who added them — named in the email. */
  invitedBy?: string | null;
  /** Request origin for the sign-in link; falls back to PUBLIC_BASE_URL. */
  baseUrl?: string;
}

/** Create a brand-new invited user (caller has checked the email is free). */
export async function createInvitedUser(
  rawEmail: string,
  opts: InviteOpts = {},
): Promise<{ id: string; tempPassword: string }> {
  const email = normalizeEmail(rawEmail);
  const id = uuid();
  const tempPassword = uuid().replace(/-/g, "").slice(0, 16);
  await getDb().run(
    "INSERT INTO users (id, email, name, password_hash, is_invited) VALUES (?, ?, ?, ?, 1)",
    [id, email, null, await hashPassword(tempPassword)],
  );

  // Best-effort, like every other send — no mail set up just means no email.
  const base = (opts.baseUrl || config.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  void sendEmailToRecipient(email, {
    status: "invited",
    docTitle: "ContextNest",
    path: "",
    actor: email,
    by: opts.invitedBy || undefined,
    tempPassword,
    promptowlSignIn: config.PROMPTOWL_SIGN_IN_GATE === "open",
    // ?invite= prefills the login page and guides them to sign in.
    link: base ? `${base}/?invite=${encodeURIComponent(email)}` : "",
  });
  return { id, tempPassword };
}

/** Existing user's id, or a new invited user (emailed) for an unknown address. */
export async function findOrCreateInvitedUser(
  rawEmail: string,
  opts: InviteOpts = {},
): Promise<{ id: string; created: boolean }> {
  const email = normalizeEmail(rawEmail);
  const existing = (await getDb().get(
    "SELECT id FROM users WHERE LOWER(email) = ?",
    [email],
  )) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };
  const { id } = await createInvitedUser(email, opts);
  return { id, created: true };
}
