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
import { aboutSurfacesUrl } from "../about-page.js";
import { getSettings } from "./settings-service.js";
import { DEFAULT_SETTINGS } from "../core/settings.js";

/**
 * po-1186 CR3: the notice ends with a link to the public member explainer
 * (GET /about/surfaces) when this server has a public base URL to link to.
 * The retention it states is the server's own `buffer_ttl_hours`, the same
 * number that page shows.
 */
export const enableNotice = (nest: string, aboutUrl: string | null = aboutSurfacesUrl(), ttlHours: number = DEFAULT_SETTINGS.buffer_ttl_hours) =>
  `Nest is now listening here for ${escapeMrkdwn(nest)}. It stays quiet unless something looks worth keeping, and then proposes it for a named person to approve. ` +
  `What it keeps: only summaries a named person approves; messages are cleared within ${ttlHours} hours. ` +
  `React 🧠 to a message to ask Nest to keep it. Say \`@Nest skip me\` and it won't use your messages. ${SERVER_ADMIN_DISCLOSURE}` +
  (aboutUrl ? ` <${aboutUrl}|How Nest handles your messages>` : "");

export async function postEnableNotice(bindingId: string): Promise<boolean> {
  const b = await getBindingRow(bindingId);
  if (!b || b.conversation_kind === "dm" || b.status !== "active" || !b.capture_ok) return false;
  const install = await getInstall(b.install_id);
  const c = install ? getConnector(install.surface) : null;
  if (!c?.postNotice) return false;
  const claim = await getDb().run("UPDATE surface_bindings SET notice_posted_at = ? WHERE id = ? AND notice_posted_at IS NULL", [new Date().toISOString(), b.id]);
  if (claim.changes === 0) return false;
  try {
    // The retention is a privacy claim: if the settings can't be read, post
    // nothing now (the claim is released below, as when Slack refuses) rather
    // than state a default that may not hold here.
    const ttl = (await getSettings()).buffer_ttl_hours;
    await c.postNotice(bindingRef(b), enableNotice(await nestName(b.nest_id), aboutSurfacesUrl(), ttl));
    return true;
  } catch {
    await getDb().run("UPDATE surface_bindings SET notice_posted_at = NULL WHERE id = ?", [b.id]);
    return false;
  }
}
