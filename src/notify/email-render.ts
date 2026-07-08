/**
 * Pure rendering for the email connector — no config/db/nodemailer imports, so
 * it's importable and testable in isolation. Turns a server-built governance
 * message (Slack-flavored: `:shortcode:` lead + `*bold*` markup) into a
 * plain-text fallback and a branded, email-client-safe HTML body.
 *
 * All user-controlled fragments (nest names, notes, emails) are HTML-escaped
 * BEFORE `*bold*` markup is applied, so a fragment can never inject markup.
 */

/** HTML-escape user-controlled fragments before they enter the HTML body. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The Slack emoji shortcodes the governance messages actually emit → the
 *  event's icon + accent colour. Unknown/absent → a neutral bell. */
export const EVENT: Record<string, { icon: string; color: string }> = {
  ":white_check_mark:": { icon: "✅", color: "#16a34a" },
  ":x:": { icon: "❌", color: "#dc2626" },
  ":memo:": { icon: "📝", color: "#d97706" },
  ":key:": { icon: "🔑", color: "#2563eb" },
};
const ALL_EMOJI: Record<string, string> = Object.fromEntries(
  Object.entries(EVENT).map(([code, m]) => [code, m.icon]),
);

/** Plain-text fallback: shortcodes → unicode, drop the *bold* markers. */
export function renderText(message: string): string {
  return message
    .replace(/:[a-z_]+:/g, (m) => ALL_EMOJI[m] ?? "")
    .replace(/\*/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Structured governance event — everything the email template needs. Built
 *  at the governance call sites (approve/reject/review/share). */
export interface EmailEventDetails {
  status: "approved" | "rejected" | "pending_review" | "shared";
  /** Document title (or nest name for a share event). */
  docTitle: string;
  /** Location: "Nest name" or "Nest name / Subfolder". */
  path: string;
  /** Actor email — the approver/rejecter/requester, or the added collaborator. */
  actor?: string;
  /** Share event: who granted access. */
  by?: string;
  /** Share event: the permission level granted (e.g. "write"). */
  permission?: string;
  version?: number | null;
  note?: string | null;
  /** Direct URL to open the document/nest ("" when no base URL is available). */
  link?: string;
}

const STATUS_META: Record<
  EmailEventDetails["status"],
  { subjectWord: string; label: string; color: string }
> = {
  approved: { subjectWord: "approved", label: "Approved", color: "#16a34a" },
  rejected: { subjectWord: "rejected", label: "Rejected", color: "#dc2626" },
  pending_review: {
    subjectWord: "awaiting review",
    label: "Pending review",
    color: "#d97706",
  },
  shared: { subjectWord: "shared with you", label: "Shared", color: "#2563eb" },
};

/**
 * Render a structured governance event into a subject + plain-text + HTML
 * email. The HTML is deliberately conservative for broad client support
 * (Gmail, Yahoo, Outlook): table layout, all styles inline, a bulletproof
 * table-cell button, no flexbox, no 8-digit-hex colours, no web fonts, and a
 * fixed `width` attribute alongside `max-width`. Every user-controlled field
 * (title, actor, note, path) is HTML-escaped.
 */
export function renderEmail(d: EmailEventDetails): {
  subject: string;
  text: string;
  html: string;
} {
  const meta = STATUS_META[d.status];
  const title = d.docTitle.replace(/[\r\n]+/g, " ").trim();
  const heading =
    d.status === "shared"
      ? `New collaborator on ${title}`
      : `${title} is ${meta.subjectWord}`;
  const subject = heading.replace(/[\r\n]+/g, " ").trim();
  const vLabel = d.version != null ? `v${d.version}` : "";
  const detailsHeader = d.status === "shared" ? "Details" : "Document details";
  const linkLabel = d.status === "shared" ? "Open nest" : "Open document";

  // ── plain-text sentence + body ──
  const byT = d.actor ? ` by ${d.actor}` : "";
  const noteT = d.note ? ` with the note: "${d.note}"` : "";
  const vT = vLabel ? ` ${vLabel}` : "";
  let lineT: string;
  switch (d.status) {
    case "approved":
      lineT = `${title}${vT} has been approved${byT}${noteT}.`;
      break;
    case "rejected":
      lineT = `${title}${vT} has been rejected${byT}${noteT}.`;
      break;
    case "pending_review":
      lineT = `A review has been requested for ${title}${vT}${byT}${noteT}.`;
      break;
    case "shared":
      lineT = `${d.actor || "A user"} was added to ${title} as ${d.permission || "a collaborator"}${d.by ? ` by ${d.by}` : ""}.`;
      break;
  }
  const text = [
    "Hi,",
    "",
    lineT,
    "",
    "Document details:",
    `  Path: ${d.path}`,
    `  Status: ${meta.label}`,
    ...(d.version != null ? [`  Version: v${d.version}`] : []),
    ...(d.link ? [`  Open: ${d.link}`] : []),
    "",
    "Regards,",
    "ContextNest",
  ].join("\n");

  // ── HTML sentence ──
  const doc = `<strong>${escapeHtml(title)}</strong>`;
  const byH = d.actor ? ` by ${escapeHtml(d.actor)}` : "";
  const noteH = d.note
    ? ` with the note: &ldquo;${escapeHtml(d.note)}&rdquo;`
    : "";
  const vH = vLabel ? ` ${vLabel}` : "";
  let lineH: string;
  switch (d.status) {
    case "approved":
      lineH = `${doc}${vH} has been approved${byH}${noteH}.`;
      break;
    case "rejected":
      lineH = `${doc}${vH} has been rejected${byH}${noteH}.`;
      break;
    case "pending_review":
      lineH = `A review has been requested for ${doc}${vH}${byH}${noteH}.`;
      break;
    case "shared":
      lineH = `${escapeHtml(d.actor || "A user")} was added to ${doc} as <strong>${escapeHtml(d.permission || "a collaborator")}</strong>${d.by ? ` by ${escapeHtml(d.by)}` : ""}.`;
      break;
  }

  const detailRow = (label: string, valueHtml: string) =>
    `<tr>
      <td style="padding:5px 0;font-size:13px;color:#6b7280;width:90px;vertical-align:top;">${label}</td>
      <td style="padding:5px 0;font-size:13px;color:#111827;vertical-align:top;">${valueHtml}</td>
    </tr>`;
  const detailRows =
    detailRow("Path", escapeHtml(d.path)) +
    detailRow(
      "Status",
      `<span style="display:inline-block;padding:2px 9px;border-radius:9999px;background:#f3f4f6;color:${meta.color};font-size:12px;font-weight:600;">${meta.label}</span>`,
    ) +
    (d.version != null ? detailRow("Version", `v${d.version}`) : "");

  const buttonRow = d.link
    ? `<tr><td style="padding:20px 24px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td bgcolor="${meta.color}" style="border-radius:6px;">
            <a href="${escapeHtml(d.link)}" target="_blank" style="display:inline-block;padding:10px 20px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${linkLabel}</a>
          </td>
        </tr></table>
      </td></tr>`
    : "";

  const html = `<div style="margin:0;padding:24px;background:#f6f8fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" align="center" style="width:100%;max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
    <tr><td style="padding:20px 24px 0;">
      <div style="font-size:12px;font-weight:700;color:#6b7280;letter-spacing:0.06em;text-transform:uppercase;">ContextNest</div>
    </td></tr>
    <tr><td style="padding:10px 24px 0;">
      <h1 style="margin:0;font-size:19px;line-height:1.35;font-weight:700;color:#111827;">${escapeHtml(heading)}</h1>
    </td></tr>
    <tr><td style="padding:16px 24px 0;font-size:14px;line-height:1.6;color:#374151;">
      Hi,<br><br>${lineH}
    </td></tr>
    <tr><td style="padding:20px 24px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #eef0f2;border-radius:8px;">
        <tr><td style="padding:12px 16px;">
          <div style="font-size:11px;font-weight:600;color:#9ca3af;letter-spacing:0.04em;text-transform:uppercase;padding-bottom:4px;">${detailsHeader}</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${detailRows}</table>
        </td></tr>
      </table>
    </td></tr>
    ${buttonRow}
    <tr><td style="padding:22px 24px 24px;font-size:14px;line-height:1.6;color:#374151;">
      Regards,<br>ContextNest
    </td></tr>
    <tr><td style="padding:14px 24px;border-top:1px solid #f0f0f0;font-size:11px;line-height:1.5;color:#9ca3af;">
      Automated governance notification from ContextNest. You received this because email notifications are enabled on this server.
    </td></tr>
  </table>
</div>`;

  return { subject, text, html };
}

/** Branded, email-client-safe HTML (inline styles, table layout). Fallback
 *  path for a bare message string with no structured details. */
export function renderHtml(message: string, nestName: string): string {
  const lead = message.match(/^(:[a-z_]+:)\s*/);
  const meta = (lead && EVENT[lead[1]]) || { icon: "🔔", color: "#475569" };
  const rest = lead ? message.slice(lead[0].length) : message;
  // `\n` → `<br>` so a multi-line body (e.g. a burst digest) keeps its line
  // breaks; HTML collapses raw newlines. Escape first, so this can't inject.
  const body = escapeHtml(rest)
    .replace(/\*([^*]+)\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
  const safeNest = escapeHtml(nestName);
  return `<div style="background:#f6f8fa;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <tr><td style="padding:20px 24px 16px;border-bottom:1px solid #f0f0f0;">
      <div style="font-size:15px;font-weight:700;color:#111827;letter-spacing:-0.01em;">ContextNest</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">${safeNest}</div>
    </td></tr>
    <tr><td style="padding:24px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td valign="top" style="font-size:22px;line-height:1;padding-right:14px;">${meta.icon}</td>
        <td valign="top" style="font-size:15px;line-height:1.55;color:#111827;border-left:3px solid ${meta.color};padding-left:14px;">${body}</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:14px 24px;border-top:1px solid #f0f0f0;font-size:11px;line-height:1.5;color:#9ca3af;">
      Automated governance notification from ContextNest. You received this because email notifications are enabled on this server.
    </td></tr>
  </table>
</div>`;
}
