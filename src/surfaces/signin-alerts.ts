/**
 * Sign-in alerts for sealed-nest owners (rounds 8-9; Misha's R4-M1 ruling,
 * 2026-11-01).
 *
 * An admin who controls sign-in or email configuration can sign in as anyone,
 * as in any application; sealing can't prevent that. It can make it visible.
 * The owner gets a Slack DM from Nest and an email when:
 *  - a session is created for them via single sign-on or OIDC (on a new
 *    device, or more than 30 days after the last sign-in by that method), a
 *    password sign-in from a new device, or a password reset (always);
 *  - an agent acts as them with a bearer ticket, or a ticket / IdP token is
 *    exchanged for one of their credentials (at most once per method per
 *    24 h, and at once for a new agent identity);
 *  - an admin changes SSO sites, OIDC, sign-in gates, the agent signing
 *    secret, SMTP/email settings or the public base URL (always, through a
 *    retried outbox);
 *  - an admin revokes their Slack link or disconnects the Slack install
 *    (before it happens, while the DM still works);
 *  - an admin turns these alerts off (always).
 *
 * The setting (`surface_settings.signin_alerts`) is ON by default. Nothing
 * here blocks a sign-in or throws; logs carry counts only.
 */
import { createHash, randomUUID } from "crypto";
import { getDb } from "../db/client.js";
import { ownsSealedNest, missingSealedTable } from "./sealed.js";
import { track } from "./services/work.js";

export type SignInMethod = "sso" | "oidc" | "password" | "reset" | "agent" | "token_exchange" | "key_exchange";

const METHOD_LABEL: Record<SignInMethod, string> = {
  sso: "single sign-on",
  oidc: "your organisation's sign-in (OIDC)",
  password: "password (new device)",
  reset: "a password reset",
  agent: "an agent ticket",
  token_exchange: "a token exchange (agent sign-in)",
  key_exchange: "a ticket-for-key exchange",
};

const AGENT_METHODS = new Set<SignInMethod>(["agent", "token_exchange", "key_exchange"]);
const AGENT_WINDOW_MS = 24 * 3600_000;
const SSO_QUIET_MS = 30 * 86400_000;

const NOT_YOU =
  "Not you? Change your password now and tell whoever runs your Nest server. Your private nest is only private while your account is yours.";

function stamp(d = new Date()): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const h = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

async function alertsOn(): Promise<boolean> {
  try {
    const { getSettings } = await import("./services/settings-service.js");
    return (await getSettings()).signin_alerts !== false;
  } catch {
    return true; // fail toward telling the owner
  }
}

/** Marks a key seen. `isNew` on its first sighting; `prevSeen` = the previous last-seen time. */
async function touch(userId: string, key: string): Promise<{ isNew: boolean; prevSeen: string | null }> {
  const db = getDb();
  const now = new Date().toISOString();
  const row = (await db.get("SELECT last_seen_at FROM surface_signin_seen WHERE user_id = ? AND seen_key = ?", [userId, key])) as
    | { last_seen_at: string }
    | undefined;
  if (!row) {
    const ins = await db.run(
      "INSERT INTO surface_signin_seen (user_id, seen_key, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, seen_key) DO NOTHING",
      [userId, key, now, now],
    );
    return { isNew: ins.changes === 1, prevSeen: null };
  }
  await db.run("UPDATE surface_signin_seen SET last_seen_at = ? WHERE user_id = ? AND seen_key = ?", [now, userId, key]);
  return { isNew: false, prevSeen: row.last_seen_at };
}

/** Compare-and-set: may this key alert now (none inside `windowMs`)? Records the alert when yes. */
async function claimAlert(userId: string, key: string, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const r = await getDb().run(
    "UPDATE surface_signin_seen SET last_alert_at = ? WHERE user_id = ? AND seen_key = ? AND (last_alert_at IS NULL OR last_alert_at <= ?)",
    [new Date(now).toISOString(), userId, key, new Date(now - windowMs).toISOString()],
  );
  return r.changes === 1;
}

/** Slack DM (every active link on a live Slack install) + email to one owner. */
async function tellOwner(userId: string, subject: string, text: string, onlyInstallId?: string): Promise<{ dms: number; emails: number }> {
  const db = getDb();
  let dms = 0;
  try {
    const { getConnector } = await import("./registry.js");
    if (getConnector("slack")) {
      const links = (await db.all(
        `SELECT l.install_id, l.surface_user_id FROM surface_identity_links l
           JOIN surface_installs i ON i.id = l.install_id
          WHERE l.community_user_id = ? AND l.status = 'active' AND l.surface = 'slack' AND i.status = 'active'
            ${onlyInstallId ? "AND l.install_id = ?" : ""}`,
        onlyInstallId ? [userId, onlyInstallId] : [userId],
      )) as Array<{ install_id: string; surface_user_id: string }>;
      const { botToken } = await import("./adapters/slack/connector.js");
      const { slackCall } = await import("./adapters/slack/api.js");
      for (const l of links) {
        try {
          const tk = await botToken(l.install_id);
          const ch = String((await slackCall("conversations.open", { users: l.surface_user_id }, { token: tk })).channel?.id ?? "");
          if (!ch) continue;
          await slackCall("chat.postMessage", { channel: ch, text }, { token: tk });
          dms++;
        } catch {
          /* next link */
        }
      }
    }
  } catch {
    /* Slack unavailable — email still goes */
  }
  let emails = 0;
  try {
    const u = (await db.get("SELECT email FROM users WHERE id = ?", [userId])) as { email: string } | undefined;
    if (u?.email) {
      const { sendPlainEmail } = await import("../notify/email.js");
      if ((await sendPlainEmail(u.email, subject, text)) === "sent") emails++;
    }
  } catch {
    /* counted below */
  }
  console.log(`[surfaces] owner alert: dms=${dms} emails=${emails}`);
  return { dms, emails };
}

async function sealedOwnerIds(): Promise<string[]> {
  try {
    const rows = (await getDb().all("SELECT DISTINCT community_user_id AS id FROM surface_personal_nests WHERE sealed = 1", [])) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch (err) {
    if (!missingSealedTable(err instanceof Error ? err.message : String(err))) console.error("[surfaces] owner alert: owner lookup failed (1)");
    return [];
  }
}

/** Should this sign-in alert? (Records what it saw either way.) */
async function shouldAlert(userId: string, method: SignInMethod, userAgent?: string, client?: string): Promise<boolean> {
  if (method === "reset") return true;
  if (method === "password") return (await touch(userId, `dev:password:${h(userAgent || "(none)")}`)).isNew;
  if (method === "sso" || method === "oidc") {
    const dev = await touch(userId, `dev:${method}:${h(userAgent || "(none)")}`);
    const m = await touch(userId, `m:${method}`);
    return dev.isNew || m.isNew || !m.prevSeen || Date.now() - Date.parse(m.prevSeen) > SSO_QUIET_MS;
  }
  if (AGENT_METHODS.has(method)) {
    const cl = await touch(userId, `client:${method}:${h(client || "(none)")}`);
    await touch(userId, `m:${method}`);
    if (cl.isNew) {
      await claimAlert(userId, `m:${method}`, 0);
      return true;
    }
    return claimAlert(userId, `m:${method}`, AGENT_WINDOW_MS);
  }
  return false;
}

/** A session, credential or reset for this user. No-op unless they own a sealed nest. */
export async function alertSealedOwnerSignIn(
  userId: string,
  method: SignInMethod,
  userAgentOrOpts?: string | { userAgent?: string; client?: string },
): Promise<void> {
  try {
    const opts = typeof userAgentOrOpts === "string" ? { userAgent: userAgentOrOpts } : (userAgentOrOpts ?? {});
    if (!(await ownsSealedNest(userId))) return;
    if (!(await alertsOn())) return;
    if (!(await shouldAlert(userId, method, opts.userAgent, opts.client))) return;
    await tellOwner(userId, "New sign-in to your Nest account", `New sign-in to your Nest account via ${METHOD_LABEL[method]} at ${stamp()}. ${NOT_YOU}`);
  } catch {
    console.error("[surfaces] sign-in alert failed (1)");
  }
}

/**
 * Fire-and-forget from a sign-in path: never delays or fails the sign-in, and
 * tracked with the other Surfaces background work (shutdown and tests wait).
 */
export function signInAlertSoon(userId: string, method: SignInMethod, userAgentOrOpts?: string | { userAgent?: string; client?: string }): void {
  track(alertSealedOwnerSignIn(userId, method, userAgentOrOpts), "sign-in alert");
}

// ─── The outbox: alerts that must be delivered ──────────────────────────────

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000, 12 * 3600_000, 24 * 3600_000];

async function enqueue(userIds: string[], subject: string, text: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  for (const id of userIds) {
    await db.run("INSERT INTO surface_alert_outbox (id, user_id, subject, text, attempts, next_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)", [
      randomUUID(),
      id,
      subject,
      text,
      now,
      now,
    ]);
  }
  if (userIds.length) {
    track(drainAlertOutbox(), "alert outbox");
  }
}

/**
 * Deliver what is due. A row is done when at least one channel took it;
 * otherwise it is retried with backoff (every guard sweep calls this) and
 * marked failed after the last step. Each row is claimed by compare-and-set
 * on `next_at`, so two drains never send it twice.
 */
export async function drainAlertOutbox(nowMs = Date.now()): Promise<{ delivered: number; retrying: number }> {
  const db = getDb();
  let delivered = 0;
  let retrying = 0;
  let rows: Array<{ id: string; user_id: string; subject: string; text: string; attempts: number; next_at: string }> = [];
  try {
    rows = (await db.all(
      "SELECT id, user_id, subject, text, attempts, next_at FROM surface_alert_outbox WHERE delivered_at IS NULL AND failed_at IS NULL AND next_at <= ? ORDER BY created_at LIMIT 50",
      [new Date(nowMs).toISOString()],
    )) as typeof rows;
  } catch (err) {
    if (!/surface_alert_outbox/.test(err instanceof Error ? err.message : String(err))) console.error("[surfaces] alert outbox read failed (1)");
    return { delivered, retrying };
  }
  for (const r of rows) {
    const attempts = Number(r.attempts) + 1;
    const retryAt = new Date(nowMs + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]).toISOString();
    const claimed = await db.run("UPDATE surface_alert_outbox SET attempts = ?, next_at = ? WHERE id = ? AND next_at = ? AND delivered_at IS NULL", [
      attempts,
      retryAt,
      r.id,
      r.next_at,
    ]);
    if (claimed.changes !== 1) continue;
    const out = await tellOwner(r.user_id, r.subject, r.text);
    if (out.dms + out.emails > 0) {
      await db.run("UPDATE surface_alert_outbox SET delivered_at = ? WHERE id = ?", [new Date().toISOString(), r.id]);
      delivered++;
    } else if (attempts > BACKOFF_MS.length) {
      await db.run("UPDATE surface_alert_outbox SET failed_at = ? WHERE id = ?", [new Date().toISOString(), r.id]);
      console.error("[surfaces] owner alert undeliverable after retries (1)");
    } else {
      retrying++;
    }
  }
  return { delivered, retrying };
}

/** An admin changed sign-in or email configuration: queue a notice to every sealed-nest owner. */
export async function alertSealedOwnersConfigChanged(what: string): Promise<void> {
  try {
    if (!(await alertsOn())) return;
    const text = `An admin changed this Nest server's sign-in or email settings (${what}) at ${stamp()}. Whoever controls those settings could sign in as you. If you didn't expect this, ask whoever runs your Nest server.`;
    await enqueue(await sealedOwnerIds(), "Your Nest server's sign-in or email settings changed", text);
  } catch {
    console.error("[surfaces] config-change alert failed (1)");
  }
}

/** Sign-in alerts were just turned off: every sealed-nest owner hears it (regardless of the setting). */
export async function alertSealedOwnersAlertsOff(): Promise<void> {
  try {
    const text = `An admin turned off sign-in alerts on this Nest server at ${stamp()}. You won't be told about new sign-ins to your account until they're turned back on. If you didn't expect this, ask whoever runs your Nest server.`;
    await enqueue(await sealedOwnerIds(), "Sign-in alerts were turned off", text);
  } catch {
    console.error("[surfaces] alerts-off notice failed (1)");
  }
}

/**
 * R5-L1: an admin is about to remove the Slack channel these alerts use —
 * revoking the owner's link, or disconnecting the install. Sent directly
 * (DM first, while the token still works) and awaited by the caller.
 */
export async function alertSealedOwnerSlackRemoval(userId: string, installId: string, kind: "link" | "install"): Promise<void> {
  try {
    if (!(await ownsSealedNest(userId))) return;
    const text =
      kind === "link"
        ? `An admin is removing your Nest Slack connection at ${stamp()}. You'll stop getting sign-in alerts in Slack; they'll still come by email. If you didn't expect this, ask whoever runs your Nest server.`
        : `An admin is disconnecting Nest from Slack at ${stamp()}. You'll stop getting sign-in alerts in Slack; they'll still come by email. If you didn't expect this, ask whoever runs your Nest server.`;
    await tellOwner(userId, kind === "link" ? "Your Nest Slack connection is being removed" : "Nest is being disconnected from Slack", text, installId);
  } catch {
    console.error("[surfaces] slack-removal notice failed (1)");
  }
}

/** Every linked sealed-nest owner on an install (for a disconnect). */
export async function sealedOwnersLinkedTo(installId: string): Promise<string[]> {
  try {
    const rows = (await getDb().all(
      `SELECT DISTINCT l.community_user_id AS id FROM surface_identity_links l
         JOIN surface_personal_nests p ON p.community_user_id = l.community_user_id AND p.sealed = 1
        WHERE l.install_id = ? AND l.status = 'active'`,
      [installId],
    )) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}

/** Which /admin/settings env names are sign-in or email configuration. */
export function authOrEmailSetting(name: string): string | null {
  if (/^(OIDC_|GOOGLE_CLIENT|MS_CLIENT|MS_TENANT)/.test(name)) return "sign-in provider";
  if (/^(PROMPTOWL_SIGN_IN_GATE|MANUAL_SIGN_IN|MCP_SIGNING_SECRET)$/.test(name)) return "sign-in";
  if (/^(SMTP_URL|EMAIL_PROVIDER|SES_|NOTIFY_EMAIL_FROM)/.test(name)) return "email";
  if (name === "PUBLIC_BASE_URL") return "server address";
  return null;
}
