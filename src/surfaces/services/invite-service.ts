/**
 * "/nest invite" (Misha, 2026-11-01): a MEMBER brings Nest back to a
 * conversation a member booted (`paused_by_member`), without an admin.
 *
 *  - Only `paused_by_member` (no other pause reason). Never `paused_guard`,
 *    `dm_off`, `dm_optout` or `removed` — those stay admin / setting decisions.
 *  - General channels: non-admins are refused, mirroring the boot.
 *  - The inviter must be a current member (unknown membership → refused).
 *  - The guard is re-checked first; it resumes only while `capture_ok` holds.
 *  - If the original booter is still a member and isn't the inviter, they get
 *    the one-tap consent prompt and Nest comes back only after they agree
 *    (`completePendingInvite`). If they left, the inviter alone is enough.
 *  - The resume is a compare-and-set to `active`; admins get a counts-only
 *    notice.
 */
import { getDb } from "../../db/client.js";
import { getConnector } from "../registry.js";
import { getBindingRow, recheckBinding } from "./binding-service.js";
import { getInstall, installRef } from "./install-store.js";
import { safeMembers } from "./members.js";
import { recordNotice } from "./notices.js";
import { askBooterConsent } from "./boot-consent.js";

export type InviteResult =
  | { ok: true; status: "resumed" | "pending_consent"; message: string }
  | { ok: false; reason: "not_member_paused" | "general_channel" | "not_member" | "guard_failed" | "changed" | "not_found"; message: string };

const iso = () => new Date().toISOString();

export const INVITE_MESSAGES = {
  not_member_paused: "Nest wasn't removed by a member here, so only an admin can bring it back (from Surfaces).",
  general_channel: "This is a general channel, so only a workspace admin can bring Nest back.",
  not_member: "Only a member of this conversation can invite Nest back.",
  guard_failed: "Nest can't come back here safely: people who can read the nest and the people here don't match any more. An admin can check it in Surfaces.",
  changed: "This conversation changed while Nest was being invited back. Try again.",
  not_found: "Nest isn't set up for this conversation.",
  resumed: "Nest is back in this conversation.",
} as const;

export async function inviteBack(input: { bindingId: string; inviterSurfaceUserId: string; isAdmin: boolean }): Promise<InviteResult> {
  const b = await getBindingRow(input.bindingId);
  if (!b) return { ok: false, reason: "not_found", message: INVITE_MESSAGES.not_found };
  if (b.status !== "paused_by_member" || (b as { pause_reason?: string | null }).pause_reason) {
    return { ok: false, reason: "not_member_paused", message: INVITE_MESSAGES.not_member_paused };
  }
  if (b.is_general && !input.isAdmin) return { ok: false, reason: "general_channel", message: INVITE_MESSAGES.general_channel };
  const install = await getInstall(b.install_id);
  if (!install || install.status !== "active") return { ok: false, reason: "not_found", message: INVITE_MESSAGES.not_found };
  const m = await safeMembers(getConnector(install.surface), installRef(install), b.conversation_id);
  if (!m.known || !m.members.some((x) => x.surface_user_id === input.inviterSurfaceUserId)) {
    return { ok: false, reason: "not_member", message: INVITE_MESSAGES.not_member };
  }
  // The guard first: never resume a conversation that isn't safe to listen in.
  const fresh = await recheckBinding(b.id);
  if (fresh.status !== "paused_by_member" || !fresh.capture_ok) return { ok: false, reason: "guard_failed", message: INVITE_MESSAGES.guard_failed };
  const booter = fresh.booted_by_surface_user_id;
  const booterPresent = !!booter && m.members.some((x) => x.surface_user_id === booter);
  if (booter && booter !== input.inviterSurfaceUserId && booterPresent && !fresh.boot_consent_at) {
    await getDb().run(
      "UPDATE surface_bindings SET invited_by_surface_user_id = ?, invited_at = ?, updated_at = ? WHERE id = ? AND status = 'paused_by_member'",
      [input.inviterSurfaceUserId, iso(), iso(), b.id],
    );
    const sent = await askBooterConsent(b.id, input.inviterSurfaceUserId).catch(() => false);
    // Re-review N4: never name the booter to the inviter.
    return {
      ok: true,
      status: "pending_consent",
      message: sent
        ? "The person who removed Nest has been asked to allow it back. Nest comes back once they agree."
        : "The person who removed Nest has to allow it back first, but Nest couldn't reach them.",
    };
  }
  const now = iso();
  // Re-review INFO: a DM binding comes back only as far as DM capture allows —
  // with capture off (org) or opted out (person) it resumes into the matching
  // paused state, never `active`.
  if (b.conversation_kind === "dm") {
    const { dmCaptureAllowed } = await import("./dm-service.js");
    const { getSettings } = await import("./settings-service.js");
    if (!(await dmCaptureAllowed({ ...fresh, status: "active" }))) {
      const reason = (await getSettings()).dm_capture ? "dm_optout" : "dm_off";
      const p = await getDb().run(
        `UPDATE surface_bindings SET status = 'paused_guard', pause_reason = ?, status_changed_at = ?, booted_by_surface_user_id = NULL, booted_at = NULL,
           boot_consent_at = NULL, invited_by_surface_user_id = NULL, invited_at = NULL, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'paused_by_member' AND version = ?`,
        [reason, now, now, b.id, fresh.version],
      );
      if (p.changes === 0) return { ok: false, reason: "changed", message: INVITE_MESSAGES.changed };
      return { ok: true, status: "resumed", message: "Nest is allowed back, but DM capture is off, so it stays paused until DM capture is on." };
    }
  }
  const r = await getDb().run(
    `UPDATE surface_bindings SET status = 'active', pause_reason = NULL, status_changed_at = ?, booted_by_surface_user_id = NULL, booted_at = NULL, boot_consent_at = NULL,
       invited_by_surface_user_id = NULL, invited_at = NULL, version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'paused_by_member' AND version = ? AND capture_ok = 1 AND guard_dirty = 0`,
    [now, now, b.id, fresh.version],
  );
  if (r.changes === 0) return { ok: false, reason: "changed", message: INVITE_MESSAGES.changed };
  await recordNotice({
    kind: "binding_invited_back",
    audience: "admins",
    bindingId: b.id,
    nestId: b.nest_id,
    detail: { resumed: 1 },
    subject: "Nest was invited back to a conversation by a member",
    text: "Nest was invited back to a conversation by a member, after a member had removed it. See Surfaces for the conversation.",
  }).catch(() => "");
  return { ok: true, status: "resumed", message: INVITE_MESSAGES.resumed };
}

/** The booter agreed: finish an invite that was waiting on them. */
export async function completePendingInvite(bindingId: string): Promise<InviteResult | null> {
  const b = await getBindingRow(bindingId);
  const inviter = (b as { invited_by_surface_user_id?: string | null } | null)?.invited_by_surface_user_id;
  if (!b || !inviter || b.status !== "paused_by_member") return null;
  return inviteBack({ bindingId, inviterSurfaceUserId: inviter, isAdmin: false });
}

/**
 * REST / MCP twin: a Community user invites Nest back. Their surface identity
 * in the binding's install (an active link) must be a current member — the
 * same rule as the slash command.
 */
export async function inviteBackAsUser(bindingId: string, userId: string): Promise<InviteResult> {
  const b = await getBindingRow(bindingId);
  if (!b) return { ok: false, reason: "not_found", message: INVITE_MESSAGES.not_found };
  const link = (await getDb().get("SELECT surface_user_id FROM surface_identity_links WHERE install_id = ? AND community_user_id = ? AND status = 'active'", [
    b.install_id,
    userId,
  ])) as { surface_user_id: string } | undefined;
  if (!link) return { ok: false, reason: "not_member", message: INVITE_MESSAGES.not_member };
  const { isOrgAdmin } = await import("./binding-service.js");
  return inviteBack({ bindingId, inviterSurfaceUserId: link.surface_user_id, isAdmin: await isOrgAdmin(userId) });
}
