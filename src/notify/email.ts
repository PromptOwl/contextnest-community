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

async function getTransporter(): Promise<any | null> {
  const url = config.SMTP_URL;
  if (!url) return null;
  // Rebuild if the admin changed the SMTP URL at runtime (settings PATCH).
  if (!transporterPromise || configuredUrl !== url) {
    configuredUrl = url;
    transporterPromise = import("nodemailer").then((nodemailer) =>
      nodemailer.default.createTransport(withTimeouts(url), {
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
