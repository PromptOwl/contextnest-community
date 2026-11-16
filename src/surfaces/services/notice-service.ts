/**
 * The one-time enable notice (AC-CRD-12, AC-CRD-11): posted exactly once per
 * binding, the first time it is enabled — never on a later re-enable (the
 * claim column survives removal and re-creation of the same binding row).
 * Besides proposal cards and their in-place updates, it is the only message
 * the bot posts in a channel.
 */
import { getDb } from "../../db/client.js";
import { getConnector } from "../registry.js";
import { SERVER_ADMIN_DISCLOSURE } from "../core/guard.js";
import { getBindingRow } from "./binding-service.js";
import { getInstall } from "./install-store.js";
import { nestName, bindingRef } from "./card-service.js";
import { escapeMrkdwn } from "../adapters/slack/blockkit.js";

export const enableNotice = (nest: string) =>
  `Nest is now listening here for ${escapeMrkdwn(nest)}. It stays quiet unless something looks worth keeping, and then proposes it for a named person to approve. ` +
  `What it keeps: only summaries a named person approves; messages are cleared within 24 hours. ` +
  `React 🧠 to a message to ask Nest to keep it. Say \`@Nest skip me\` and it won't use your messages. ${SERVER_ADMIN_DISCLOSURE}`;

export async function postEnableNotice(bindingId: string): Promise<boolean> {
  const b = await getBindingRow(bindingId);
  if (!b || b.conversation_kind === "dm" || b.status !== "active" || !b.capture_ok) return false;
  const install = await getInstall(b.install_id);
  const c = install ? getConnector(install.surface) : null;
  if (!c?.postNotice) return false;
  const claim = await getDb().run("UPDATE surface_bindings SET notice_posted_at = ? WHERE id = ? AND notice_posted_at IS NULL", [new Date().toISOString(), b.id]);
  if (claim.changes === 0) return false;
  try {
    await c.postNotice(bindingRef(b), enableNotice(await nestName(b.nest_id)));
    return true;
  } catch {
    await getDb().run("UPDATE surface_bindings SET notice_posted_at = NULL WHERE id = ?", [b.id]);
    return false;
  }
}
