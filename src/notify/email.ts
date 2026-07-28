/**
 * Email connector — optional team notifications over SMTP via nodemailer.
 *
 * Dependency posture (see the supply-chain scan in the PR/ticket): nodemailer
 * is pinned EXACTLY to 9.0.3 — zero runtime deps, zero install scripts,
 * registry-signed, no unpatched advisories. Usage is deliberately hardened:
 *   - SMTP transport only (never sendmail — no child_process path)
 *   - disableFileAccess / disableUrlAccess on the transport AND no `raw`
 *     option ever, so a message can't be turned into a file read or SSRF
 *   - recipients/subjects are server-built from governance events; no
 *     user-controlled transport or envelope input
 * Bumping the version must go through PR review with a fresh advisory check.
 *
 * Same failure posture as the Slack connector: fire-and-forget, a broken
 * SMTP server must never slow down or fail the governance action; warn once.
 */
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import {
  renderHtml,
  renderText,
  renderEmail,
  type EmailEventDetails,
} from "./email-render.js";

let transporterPromise: Promise<any> | null = null;
let configuredUrl: string | null = null;
let warnedOnce = false;

/**
 * Timeout parity with the Slack connector (3s abort): an SMTP outage must not
 * leave a connection hanging for nodemailer's ~2min defaults per event.
 *
 * These MUST ride on the URL query string, not a sibling options object.
 * `createTransport(urlString, opts)` parses the URL into the transport config
 * and drops `opts` into PER-MESSAGE defaults — the transport-level socket
 * timeouts there are silently ignored (verified against nodemailer 9.0.3:
 * lib/nodemailer.js → `options = parseConnectionUrl(urlConfig)`, second arg
 * never reaches SMTPTransport; a `{ url, ...opts }` object drops the siblings
 * for the same reason). `parseConnectionUrl` DOES copy URL query params into
 * transport options, so this is the only channel that actually lands them.
 * String-appended (not re-encoded through URL()) to byte-preserve inline
 * credentials.
 *
 * Only append a param the admin hasn't already set: a DUPLICATE key makes
 * nodemailer's parser collapse it to an array (`connectionTimeout: ['9999',
 * '5000']`), which is not a number and silently disables the timeout — the
 * exact hang this guards against. So an admin-supplied value is preserved and
 * never duplicated.
 */
const SMTP_TIMEOUT_DEFAULTS: Array<[string, number]> = [
  ["connectionTimeout", 5000],
  ["greetingTimeout", 5000],
  ["socketTimeout", 10000],
];
export function withTimeouts(url: string): string {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const missing = SMTP_TIMEOUT_DEFAULTS.filter(
    ([name]) => !new RegExp(`(^|&)${name}=`, "i").test(query),
  ).map(([name, ms]) => `${name}=${ms}`);
  if (missing.length === 0) return url;
  return url + (url.includes("?") ? "&" : "?") + missing.join("&");
}

/**
 * Throttle the send path so a burst (a team share fanning out to a dozen
 * members, several governance events in the same tick) never exceeds the SMTP
 * provider's per-second cap and gets a `550 Too many emails` — which drops the
 * whole message. nodemailer's SMTP pool QUEUES excess messages and dispatches
 * them at `rateLimit` per `rateDelta`ms over one reused connection, so overflow
 * is delayed, not rejected. Sends are fire-and-forget, so the delay never
 * touches the request.
 *
 * Same URL-query channel as withTimeouts (the options-arg is ignored for a URL
 * transport). `pool` is only ever appended as `true` — a stray `pool=false`
 * string would read truthy. Admin-supplied values are preserved, never doubled.
 * The rate is set here, deliberately conservative — safely under typical
 * provider limits.
 */
const POOL_DEFAULTS: Array<[string, string]> = [
  ["pool", "true"],
  ["maxConnections", "1"],
  ["rateDelta", "1000"],
  ["rateLimit", "8"], // messages per second
];
export function withPool(url: string): string {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  const missing = POOL_DEFAULTS.filter(
    ([name]) => !new RegExp(`(^|&)${name}=`, "i").test(query),
  ).map(([name, val]) => `${name}=${val}`);
  if (missing.length === 0) return url;
  return url + (url.includes("?") ? "&" : "?") + missing.join("&");
}

/**
 * Live credential check for the /admin/settings save path: actually connect to
 * the SMTP server and authenticate, so a wrong host/port/user/password is
 * caught before the setting is persisted (a bare shape check can't know the
 * password is wrong). Same hardening as the send path — timeouts ride the URL
 * so a dead host can't hang the request, file/URL access disabled. Never
 * throws: returns a typed result the caller turns into a 400.
 */
export async function verifySmtp(
  url: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let transporter: any = null;
  try {
    const nodemailer = await import("nodemailer");
    transporter = nodemailer.default.createTransport(withTimeouts(url), {
      disableFileAccess: true,
      disableUrlAccess: true,
    } as any);
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // A verify transporter is throwaway — release its socket/pool so it can't
    // linger. close() is best-effort (may not exist on a failed build).
    try {
      transporter?.close?.();
    } catch {
      /* nothing to release */
    }
  }
}

async function getTransporter(): Promise<any | null> {
  const url = config.SMTP_URL;
  if (!url) return null;
  // Rebuild if the admin changed the SMTP URL at runtime (settings PATCH).
  if (!transporterPromise || configuredUrl !== url) {
    configuredUrl = url;
    transporterPromise = import("nodemailer").then((nodemailer) =>
      // withPool → connection pool + per-second rate limit, so a burst queues
      // instead of tripping the provider's "too many emails" 550.
      nodemailer.default.createTransport(withPool(withTimeouts(url)), {
        // Per-message defaults (belt-and-braces; also set on each sendMail).
        disableFileAccess: true,
        disableUrlAccess: true,
      } as any),
    );
    // A rejected build must not be cached forever (a settled Promise is
    // truthy) — reset so the next event retries instead of silently dying.
    transporterPromise.catch(() => {
      transporterPromise = null;
      configuredUrl = null;
    });
  }
  return transporterPromise;
}

export async function notifyEmailForNest(
  nestId: string,
  message: string,
  details?: EmailEventDetails,
): Promise<void> {
  const from = config.NOTIFY_EMAIL_FROM;
  const to = config.NOTIFY_EMAIL_TO;
  if (!config.SMTP_URL || !from || !to) return;
  try {
    const transporter = await getTransporter();
    if (!transporter) return;

    let subject: string;
    let text: string;
    let html: string;
    if (details) {
      // Structured event → rich, per-event email (title, details, link).
      ({ subject, text, html } = renderEmail(details));
    } else {
      // Fallback: a bare Slack-flavored message with no structured details.
      let name = nestId;
      try {
        const row = (await getDb().get("SELECT name FROM nests WHERE id = ?", [
          nestId,
        ])) as { name?: string } | undefined;
        if (row?.name) name = row.name;
      } catch {
        /* name lookup is cosmetic */
      }
      // Strip CR/LF so an embedded newline can't inject extra headers.
      const safeName = name.replace(/[\r\n]+/g, " ").trim();
      subject = `ContextNest · ${safeName}`;
      text = renderText(message);
      html = renderHtml(message, safeName);
    }

    // Multipart: plain-text fallback + branded HTML.
    await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "[email] notification failed (suppressing further warnings):",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Send a rich governance email to explicit recipient(s) — one address, or an
 * array (e.g. every reviewer steward on a submit), delivered in a single send.
 * Independent of the NOTIFY_EMAIL_TO team channel; same transport, rendering and
 * fire-and-forget posture as notifyEmailForNest. Gated on SMTP_URL +
 * NOTIFY_EMAIL_FROM + at least one recipient — the team-channel address is
 * irrelevant here, so emailing an invitee/reviewer never depends on it.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A provider throttle ("too many emails", 4xx greylist, Mailtrap's 550 5.7.0
 * rate reply) is transient — the send will land on a retry. A hard reject
 * (bad recipient, auth) is not, so we only retry the throttle shapes and let
 * everything else fail fast.
 */
export function isRateLimited(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  const code = Number((err as any)?.responseCode);
  return (
    /too many|rate limit|throttl|try again|4\.7\.\d|too many emails/i.test(msg) ||
    code === 421 ||
    code === 429 ||
    code === 450 ||
    code === 451 ||
    (code === 550 && /too many|rate/i.test(msg))
  );
}

/**
 * Send with backoff on provider rate limits. The pool caps our steady rate; this
 * catches the overflow a fixed cap can't predict (every provider/plan differs),
 * re-sending after 1s, 2s, 4s, 8s instead of dropping the message. All in the
 * background (sends are fire-and-forget), so retries never touch the request.
 */
async function sendMailWithRetry(
  transporter: any,
  msg: Record<string, unknown>,
  attempts = 5,
): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      return await transporter.sendMail(msg);
    } catch (err) {
      if (i >= attempts - 1 || !isRateLimited(err)) throw err;
      const wait = 1000 * 2 ** i; // 1s, 2s, 4s, 8s
      await sleep(wait);
    }
  }
}

export async function sendEmailToRecipient(
  to: string | string[],
  details: EmailEventDetails,
): Promise<void> {
  const from = config.NOTIFY_EMAIL_FROM;
  const hasRecipient = Array.isArray(to) ? to.length > 0 : !!to;
  if (!config.SMTP_URL || !from || !hasRecipient) return;
  try {
    const transporter = await getTransporter();
    if (!transporter) return;
    const { subject, text, html } = renderEmail(details);
    await sendMailWithRetry(transporter, {
      from,
      to,
      subject,
      text,
      html,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "[email] notification failed (suppressing further warnings):",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
