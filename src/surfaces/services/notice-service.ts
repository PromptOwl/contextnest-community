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
import { errorCode } from "../log.js";

/** Nest names are capped in the notice so a long one can't crowd out the disclosure and the link. */
export const NOTICE_NEST_MAX = 80;
const capName = (s: string) => (s.length > NOTICE_NEST_MAX ? `${s.slice(0, NOTICE_NEST_MAX - 1)}…` : s);

/** A mention by Slack id, so any app name (or a later rename) reads right. */
const botMention = (botUserId: string | null) => (botUserId && /^[A-Z0-9]+$/.test(botUserId) ? `<@${botUserId}>` : null);

/**
 * po-1186 CR3: the notice ends with a link to the public member explainer
 * (GET /about/surfaces) when this server has a public base URL to link to.
 * The retention it states is the server's own `buffer_ttl_hours`, the same
 * number that page shows. Every argument is required, so no caller can state
 * a default retention by leaving one out.
 */
export const enableNotice = (nest: string, aboutUrl: string | null, ttlHours: number, botUserId: string | null) =>
  `${botMention(botUserId) ?? "This app"} is now listening here for ${escapeMrkdwn(capName(nest))}. It stays quiet unless something looks worth keeping, and then proposes it for a named person to approve. ` +
  `What it keeps: only summaries a named person approves; messages are cleared within ${ttlHours} hours. ` +
  `React 🧠 to a message to ask Nest to keep it. Mention ${botMention(botUserId) ?? "this app"} and say "skip me" and it won't use your messages. ${SERVER_ADMIN_DISCLOSURE}` +
  (aboutUrl ? ` <${aboutUrl}|How Nest handles your messages>` : "");

/**
 * What happened to a binding's one notice:
 *   posted          — posted now;
 *   already_posted  — it went out earlier (e.g. a removed channel bound again);
 *   not_needed      — no notice for this binding (a DM, not active, capture
 *                     not safe, or a surface without notices);
 *   failed          — not posted (Slack refused, or the settings couldn't be
 *                     read); the claim is released, so the next create retries.
 */
export type NoticeOutcome = "posted" | "already_posted" | "not_needed" | "failed";

export async function postEnableNotice(bindingId: string): Promise<NoticeOutcome> {
  const b = await getBindingRow(bindingId);
  if (!b || b.conversation_kind === "dm" || b.status !== "active" || !b.capture_ok) return "not_needed";
  const install = await getInstall(b.install_id);
  const c = install ? getConnector(install.surface) : null;
  if (!c?.postNotice) return "not_needed";
  const claim = await getDb().run("UPDATE surface_bindings SET notice_posted_at = ? WHERE id = ? AND notice_posted_at IS NULL", [new Date().toISOString(), b.id]);
  if (claim.changes === 0) return "already_posted";
  try {
    // The retention is a privacy claim: if the settings can't be read, post
    // nothing now (the claim is released below, as when Slack refuses) rather
    // than state a default that may not hold here.
    const ttl = (await getSettings()).buffer_ttl_hours;
    await c.postNotice(bindingRef(b), enableNotice(await nestName(b.nest_id), aboutSurfacesUrl(), ttl, install!.bot_user_id));
    return "posted";
  } catch (err) {
    // No message text or names: the binding id and the error's code only (po-1447).
    console.warn(`[surfaces] enable notice not posted for binding ${b.id}: code=${errorCode(err)}`);
    await getDb().run("UPDATE surface_bindings SET notice_posted_at = NULL WHERE id = ?", [b.id]);
    return "failed";
  }
}
