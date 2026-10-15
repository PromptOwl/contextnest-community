/**
 * Email connector — optional notifications via nodemailer, over SMTP or AWS SES.
 *
 * Dependency posture (see the supply-chain scan in the PR/ticket): nodemailer
 * is pinned EXACTLY to 9.0.3 — zero runtime deps, zero install scripts,
 * registry-signed, no unpatched advisories. Usage is deliberately hardened:
 *   - SMTP or the AWS SES SDK transport only (never sendmail — no
 *     child_process path)
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
import { recordOutbound, type OutboundContext } from "./outbound-log.js";

let transporterPromise: Promise<any> | null = null;
let configuredKey: string | null = null;
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

export type TransportSettings =
  | { provider: "smtp"; url: string }
  | {
      provider: "ses";
      region: string;
      accessKeyId: string | null;
      secretAccessKey: string | null;
    };

/**
 * The selected provider's settings, or null when that provider isn't set up.
 * `over` (env name → value) previews unsaved values, for the settings save check.
 */
export function transportSettings(
  over: Record<string, string | null> = {},
): TransportSettings | null {
  const v = (name: string, current: string | null) =>
    name in over ? over[name] : current;
  if (v("EMAIL_PROVIDER", config.EMAIL_PROVIDER) === "ses") {
    const region = v("SES_REGION", config.SES_REGION);
    return region
      ? {
          provider: "ses",
          region,
          accessKeyId: v("SES_ACCESS_KEY_ID", config.SES_ACCESS_KEY_ID),
          secretAccessKey: v("SES_SECRET_ACCESS_KEY", config.SES_SECRET_ACCESS_KEY),
        }
      : null;
  }
  const url = v("SMTP_URL", config.SMTP_URL);
  return url ? { provider: "smtp", url } : null;
}

/**
 * SMTP: pooled + timeouts on the URL (see withPool/withTimeouts). SES: the
 * SDK client; no static keys → AWS default credential chain (IAM role etc.).
 */
async function createTransport(s: TransportSettings, pooled: boolean): Promise<any> {
  const nodemailer = (await import("nodemailer")).default;
  const hardening = { disableFileAccess: true, disableUrlAccess: true };
  if (s.provider === "smtp") {
    const url = withTimeouts(s.url);
    return nodemailer.createTransport(pooled ? withPool(url) : url, hardening as any);
  }
  const ses = await import("@aws-sdk/client-sesv2");
  const sesClient = new ses.SESv2Client({
    region: s.region,
    ...(s.accessKeyId && s.secretAccessKey
      ? { credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } }
      : {}),
  });
  return nodemailer.createTransport({
    SES: { sesClient, SendEmailCommand: ses.SendEmailCommand },
    ...hardening,
  } as any);
}

/**
 * Live credential check for the /admin/settings save path: SMTP connects and
 * authenticates; SES sends a probe nodemailer treats as ok unless auth/region
 * fails. Catches bad credentials before they're persisted. Never throws:
 * returns a typed result the caller turns into a 400.
 */
export async function verifyEmailTransport(
  s: TransportSettings,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let transporter: any = null;
  try {
    transporter = await createTransport(s, false);
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
  const s = transportSettings();
  if (!s) return null;
  const key = JSON.stringify(s);
  // Rebuild if the admin changed the email settings at runtime (settings PATCH).
  if (!transporterPromise || configuredKey !== key) {
    configuredKey = key;
    transporterPromise = createTransport(s, true);
    // A rejected build must not be cached forever (a settled Promise is
    // truthy) — reset so the next event retries instead of silently dying.
    transporterPromise.catch(() => {
      transporterPromise = null;
      configuredKey = null;
    });
  }
  return transporterPromise;
}

export async function notifyEmailForNest(
  nestId: string,
  message: string,
  details?: EmailEventDetails,
  ctx: OutboundContext = {},
): Promise<void> {
  const from = config.NOTIFY_EMAIL_FROM;
  const to = config.NOTIFY_EMAIL_TO;
  if (!transportSettings() || !from || !to) return;
  let subject = "";
  let text = "";
  try {
    const transporter = await getTransporter();
    if (!transporter) return;

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
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text,
      html,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    await recordOutbound({
      channel: "email",
      ...ctx,
      nestId: ctx.nestId ?? nestId,
      recipients: [to],
      subject,
      body: text,
      status: "sent",
      providerId: info?.messageId ?? null,
      secrets: [details?.tempPassword],
    });
  } catch (err) {
    await recordOutbound({
      channel: "email",
      ...ctx,
      nestId: ctx.nestId ?? nestId,
      recipients: [to],
      subject,
      body: text,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      secrets: [details?.tempPassword],
    });
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
 * fire-and-forget posture as notifyEmailForNest. Gated on a configured transport (SMTP or SES) +
 * NOTIFY_EMAIL_FROM + at least one recipient — the team-channel address is
 * irrelevant here, so emailing an invitee/reviewer never depends on it.
 */
/**
 * Can this server actually deliver mail to a named recipient? The exact
 * condition `sendEmailToRecipient` gates on, exported so callers that would be
 * BROKEN rather than merely quieter without mail (publishing an email- or
 * invite-gated link, whose only way in is a mailed link) can refuse up front
 * instead of silently producing something nobody can open.
 */
export function isEmailConfigured(): boolean {
  return !!transportSettings() && !!config.NOTIFY_EMAIL_FROM;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Choose the envelope so a multi-recipient send (every reviewer steward, a
 * team's members) never exposes the roster: a single recipient goes on `To`,
 * but two or more go on `Bcc` (with `To` set to the sender) so no recipient
 * sees another's address. Each person still receives their own copy.
 */
export function recipientEnvelope(
  to: string | string[],
  from: string,
): { to: string; bcc?: string[] } {
  const recipients = Array.isArray(to) ? to : [to];
  return recipients.length > 1
    ? { to: from, bcc: recipients }
    : { to: recipients[0] };
}

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
    /too many|rate limit|rate exceeded|throttl|try again|4\.7\.\d|too many emails/i.test(msg) ||
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

/**
 * Recipients mail can actually reach. Service identities — access keys and
 * metacognition personas — have `.invalid` addresses (RFC 2606) that no
 * mailbox answers; sending to one only earns the server a bounce. A verdict on
 * a persona's proposal is the common case: reject() emails its requester.
 */
export function deliverableRecipients(to: string | string[]): string[] {
  return (Array.isArray(to) ? to : [to]).filter((a) => !!a && !/\.invalid$/i.test(a.trim()));
}

export async function sendEmailToRecipient(
  rawTo: string | string[],
  details: EmailEventDetails,
  ctx: OutboundContext = {},
): Promise<void> {
  const from = config.NOTIFY_EMAIL_FROM;
  const to = deliverableRecipients(rawTo);
  const hasRecipient = to.length > 0;
  if (!transportSettings() || !from) return;
  const secrets = [details.tempPassword];
  if (!hasRecipient) {
    // Every address was a service identity (.invalid) — nothing to deliver,
    // but the log should still show the message was addressed and dropped.
    await recordOutbound({
      channel: "email",
      ...ctx,
      recipients: Array.isArray(rawTo) ? rawTo : [rawTo],
      subject: details.docTitle,
      status: "skipped",
      error: "No deliverable recipient (service identities only).",
      secrets,
    });
    return;
  }
  let rendered: { subject: string; text: string } = { subject: details.docTitle, text: "" };
  try {
    const transporter = await getTransporter();
    if (!transporter) return;
    const { subject, text, html } = renderEmail(details);
    rendered = { subject, text };
    const info = await sendMailWithRetry(transporter, {
      from,
      ...recipientEnvelope(to, from),
      subject,
      text,
      html,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    await recordOutbound({
      channel: "email",
      ...ctx,
      recipients: to,
      subject,
      body: text,
      status: "sent",
      providerId: info?.messageId ?? null,
      secrets,
    });
  } catch (err) {
    await recordOutbound({
      channel: "email",
      ...ctx,
      recipients: to,
      subject: rendered.subject,
      body: rendered.text,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      secrets,
    });
    if (!warnedOnce) {
      warnedOnce = true;
      console.warn(
        "[email] notification failed (suppressing further warnings):",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
