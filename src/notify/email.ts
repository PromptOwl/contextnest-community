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

let transporterPromise: Promise<any> | null = null;
let configuredUrl: string | null = null;
let warnedOnce = false;

async function getTransporter(): Promise<any | null> {
  const url = config.SMTP_URL;
  if (!url) return null;
  // Rebuild if the admin changed the SMTP URL at runtime (settings PATCH).
  if (!transporterPromise || configuredUrl !== url) {
    configuredUrl = url;
    transporterPromise = import("nodemailer").then((nodemailer) =>
      nodemailer.default.createTransport(url, {
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
  }
  return transporterPromise;
}

export async function notifyEmailForNest(
  nestId: string,
  message: string,
): Promise<void> {
  const from = config.NOTIFY_EMAIL_FROM;
  const to = config.NOTIFY_EMAIL_TO;
  if (!config.SMTP_URL || !from || !to) return;
  try {
    const transporter = await getTransporter();
    if (!transporter) return;
    let nestName = nestId;
    try {
      const row = (await getDb().get("SELECT name FROM nests WHERE id = ?", [
        nestId,
      ])) as { name?: string } | undefined;
      if (row?.name) nestName = row.name;
    } catch {
      /* name lookup is cosmetic */
    }
    // Slack-flavored markup reads fine enough in plain text for v1.
    const text = message.replace(/:[a-z_]+:/g, "").trim();
    await transporter.sendMail({
      from,
      to,
      subject: `ContextNest · ${nestName}`,
      text,
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
