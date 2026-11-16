/**
 * AC-BOOT-04: when an admin tries to re-bind a booted conversation while the
 * member who booted it is still there, that member gets a one-tap "Allow
 * Nest back" prompt in a direct message (the only DM Surfaces sends on
 * someone's behalf, and only in answer to an admin's re-bind attempt).
 */
import { getBindingRow } from "./binding-service.js";
import { getInstall, installRef } from "./install-store.js";
import { getConnector } from "../registry.js";
import { botToken } from "../adapters/slack/connector.js";
import { slackCall } from "../adapters/slack/api.js";
import { ACTION } from "../adapters/slack/blockkit.js";

/** `inviterSurfaceUserId` set → a member asked (/nest invite); null → an admin's re-bind. */
export async function askBooterConsent(bindingId: string, inviterSurfaceUserId: string | null = null): Promise<boolean> {
  const b = await getBindingRow(bindingId);
  if (!b || b.status !== "paused_by_member" || !b.booted_by_surface_user_id || b.boot_consent_at) return false;
  const install = await getInstall(b.install_id);
  if (!install || install.surface !== "slack" || !getConnector("slack")) return false;
  void installRef;
  try {
    const tk = await botToken(install.id);
    const ch = String((await slackCall("conversations.open", { users: b.booted_by_surface_user_id }, { token: tk })).channel?.id ?? "");
    if (!ch) return false;
    const where = b.conversation_name ? `#${b.conversation_name}` : "a conversation";
    // Re-review N4: say who is asking — a member (by mention) or an admin.
    const asker = inviterSurfaceUserId && /^[A-Z0-9_]+$/.test(inviterSurfaceUserId) ? `<@${inviterSurfaceUserId}>` : "An admin";
    await slackCall(
      "chat.postMessage",
      {
        channel: ch,
        text: `${asker} would like to add Nest back to ${where}, where you removed it. It only comes back if you agree.`,
        blocks: JSON.stringify([
          { type: "section", text: { type: "mrkdwn", text: `${asker} would like to add Nest back to ${where.replace(/[<>&]/g, "")}, where you removed it. It only comes back if you agree.` } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Allow Nest back" }, action_id: ACTION.allowBack, value: JSON.stringify({ b: b.id }) }] },
        ]),
      },
      { token: tk },
    );
    return true;
  } catch {
    return false;
  }
}
