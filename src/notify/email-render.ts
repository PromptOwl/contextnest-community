/**
 * Pure rendering for the email connector — no config/db/nodemailer imports, so
 * it's importable and testable in isolation. Turns a server-built governance
 * message (Slack-flavored: `:shortcode:` lead + `*bold*` markup) into a
 * plain-text fallback and a branded, email-client-safe HTML body.
 *
 * All user-controlled fragments (nest names, notes, emails) are HTML-escaped
 * BEFORE `*bold*` markup is applied, so a fragment can never inject markup.
 */
import { permissionLabel } from "../governance/roles.js";

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
  status:
    | "approved"
    | "mention"
    | "rejected"
    | "pending_review"
    | "shared"
    | "doc_shared"
    | "invited"
    | "steward"
    | "deletion_requested"
    | "deletion_declined"
    | "deletion_deleted"
    | "deletion_archived";
  /** Document title (or nest name for a share event). */
  docTitle: string;
  /** Location: "Nest name" or "Nest name / Subfolder". */
  path: string;
  /** Actor email — the approver/rejecter/requester, or the added collaborator. */
  actor?: string;
  /** Share event: who granted access. */
  by?: string;
  /** Share event: the permission level granted (e.g. "write").
   *  Steward event: the steward role (viewer/editor/reviewer). */
  permission?: string;
  /** Steward event: the human scope the role covers (e.g. "#billing"). */
  scopeLabel?: string;
  /** Teammate-invite event: the one-time temporary password to sign in with. */
  tempPassword?: string;
  /** Teammate-invite event: PromptOwl sign-in is open, so mention it as an option. */
  promptowlSignIn?: boolean;
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
  mention: { subjectWord: "mentioned you", label: "Mention", color: "#7c3aed" },
  rejected: { subjectWord: "rejected", label: "Rejected", color: "#dc2626" },
  pending_review: {
    subjectWord: "awaiting review",
    label: "Pending review",
    color: "#d97706",
  },
  shared: { subjectWord: "shared with you", label: "Shared", color: "#2563eb" },
  doc_shared: { subjectWord: "shared with you", label: "Shared", color: "#2563eb" },
  invited: { subjectWord: "invited you", label: "Invitation", color: "#2563eb" },
  steward: { subjectWord: "steward", label: "Steward", color: "#7c3aed" },
  deletion_requested: {
    subjectWord: "flagged for deletion",
    label: "Deletion requested",
    color: "#d97706",
  },
  deletion_declined: {
    subjectWord: "kept",
    label: "Deletion rejected",
    color: "#d97706",
  },
  deletion_deleted: {
    subjectWord: "deleted",
    label: "Deleted",
    color: "#dc2626",
  },
  // An honoured ARCHIVE request. Deliberately not the deletion palette: the
  // nest is intact and restorable, and red "Deleted" would tell the requester
  // the opposite of what happened.
  deletion_archived: {
    subjectWord: "archived",
    label: "Archived",
    color: "#0891b2",
  },
};

/** First-letter capitalize for tidy detail values (role/scope). */
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Share copy names the role ("Viewer"), never the raw permission ("read"). */
const shareRole = (permission?: string) =>
  permission ? permissionLabel(permission) : "collaborator";

/** One details-table row rendered to an HTML `<tr>` (label + value cell). */
const detailRow = (label: string, valueHtml: string) =>
  `<tr>
      <td style="padding:5px 0;font-size:13px;color:#6b7280;width:90px;vertical-align:top;">${label}</td>
      <td style="padding:5px 0;font-size:13px;color:#111827;vertical-align:top;">${valueHtml}</td>
    </tr>`;

/** Fragments precomputed once per render so the per-status templates below stay
 *  declarative — no re-deriving the bold title / "by …" / note / version bits. */
interface RenderCtx {
  d: EmailEventDetails;
  title: string; // plain, CR/LF-stripped
  doc: string; // <strong>escaped title</strong>
  byT: string;
  byH: string;
  noteT: string;
  noteH: string;
  vT: string;
  vH: string;
  meta: { subjectWord: string; label: string; color: string };
  statusBadge: string;
  codeValue: (v: string) => string;
}

/** A details row's value in both renderings: `text` (plain) + `html` (safe). */
type RowSpec = { label: string; text: string; html: string };

interface EmailTemplate {
  heading: (x: RenderCtx) => string;
  detailsHeader: string;
  linkLabel: string;
  lineT: (x: RenderCtx) => string; // plain-text sentence
  lineH: (x: RenderCtx) => string; // HTML sentence
  rows: (x: RenderCtx) => RowSpec[];
}

/** Plain value row → HTML-escaped for the value cell. */
const plainRow = (label: string, value: string): RowSpec => ({
  label,
  text: value,
  html: escapeHtml(value),
});

/** Governance events (approve/reject/review) share one details block. */
const governanceRows = (x: RenderCtx): RowSpec[] => [
  plainRow("Path", x.d.path),
  { label: "Status", text: x.meta.label, html: x.statusBadge },
  ...(x.d.version != null ? [plainRow("Version", `v${x.d.version}`)] : []),
];

/**
 * One template per event type — the single place email copy lives. Each entry
 * owns its heading, sentence (plain + HTML), details header, link label, and
 * detail rows; renderEmail just looks one up by `status` and fills it. Adding a
 * new email = adding one entry here, no scattered `status === …` branches.
 */
const PROMPTOWL_LINE =
  " Or choose Sign in with PromptOwl, using a PromptOwl account under this same email.";

const TEMPLATES: Record<EmailEventDetails["status"], EmailTemplate> = {
  approved: {
    heading: (x) => `${x.title} is ${x.meta.subjectWord}`,
    detailsHeader: "Document details",
    linkLabel: "Open document",
    lineT: (x) => `${x.title}${x.vT} has been approved${x.byT}${x.noteT}.`,
    lineH: (x) => `${x.doc}${x.vH} has been approved${x.byH}${x.noteH}.`,
    rows: governanceRows,
  },
  // A mention names one person, so this is the one template addressed to
  // "you". `note` carries the comment's own words when there are any — a
  // mention with no context reads as a summons.
  mention: {
    heading: (x) => `${x.d.actor || "Someone"} mentioned you in ${x.title}`,
    detailsHeader: "Document details",
    linkLabel: "Open document",
    lineT: (x) => `You were mentioned in ${x.title}${x.byT}${x.noteT}.`,
    lineH: (x) => `You were mentioned in ${x.doc}${x.byH}${x.noteH}.`,
    rows: (x) => [plainRow("Nest", x.d.path)],
  },
  rejected: {
    heading: (x) => `${x.title} is ${x.meta.subjectWord}`,
    detailsHeader: "Document details",
    linkLabel: "Open document",
    lineT: (x) => `${x.title}${x.vT} has been rejected${x.byT}${x.noteT}.`,
    lineH: (x) => `${x.doc}${x.vH} has been rejected${x.byH}${x.noteH}.`,
    rows: governanceRows,
  },
  pending_review: {
    heading: (x) => `${x.title} is ${x.meta.subjectWord}`,
    detailsHeader: "Document details",
    linkLabel: "Open document",
    lineT: (x) =>
      `A review has been requested for ${x.title}${x.vT}${x.byT}${x.noteT}.`,
    lineH: (x) =>
      `A review has been requested for ${x.doc}${x.vH}${x.byH}${x.noteH}.`,
    rows: governanceRows,
  },
  shared: {
    heading: (x) => `You've been added to ${x.title}`,
    detailsHeader: "Details",
    linkLabel: "Open nest",
    lineT: (x) =>
      `You've been given ${shareRole(x.d.permission)} access to ${x.title}${x.d.by ? ` by ${x.d.by}` : ""}. Open it below to start collaborating.`,
    lineH: (x) =>
      `You've been given <strong>${escapeHtml(shareRole(x.d.permission))}</strong> access to ${x.doc}${x.d.by ? ` by ${escapeHtml(x.d.by)}` : ""}. Open it below to start collaborating.`,
    rows: (x) => [
      plainRow("Nest", x.d.path),
      ...(x.d.permission ? [plainRow("Role", shareRole(x.d.permission))] : []),
    ],
  },
  // One document or folder shared with someone outside the nest. A nest-wide
  // share uses `shared` above, so the person gets one email, never one per doc.
  doc_shared: {
    heading: (x) => `${x.title} was shared with you`,
    detailsHeader: "Details",
    linkLabel: "Open",
    lineT: (x) =>
      `You've been given ${shareRole(x.d.permission)} access to ${x.title}${x.d.by ? ` by ${x.d.by}` : ""}.`,
    lineH: (x) =>
      `You've been given <strong>${escapeHtml(shareRole(x.d.permission))}</strong> access to ${x.doc}${x.d.by ? ` by ${escapeHtml(x.d.by)}` : ""}.`,
    rows: (x) => [
      plainRow("Nest", x.d.path),
      ...(x.d.permission ? [plainRow("Role", shareRole(x.d.permission))] : []),
    ],
  },
  invited: {
    heading: (x) => `You've been invited to ${x.title}`,
    detailsHeader: "Sign-in details",
    linkLabel: "Sign in",
    lineT: (x) =>
      `You've been invited to ${x.title}${x.d.by ? ` by ${x.d.by}` : ""}. Sign in with your email and the temporary password below, then choose your own password.${x.d.promptowlSignIn ? PROMPTOWL_LINE : ""}`,
    lineH: (x) =>
      `You've been invited to ${x.doc}${x.d.by ? ` by ${escapeHtml(x.d.by)}` : ""}. Sign in with your email and the temporary password below, then choose your own password.${x.d.promptowlSignIn ? PROMPTOWL_LINE : ""}`,
    rows: (x) => [
      plainRow("Email", x.d.actor || ""),
      ...(x.d.tempPassword
        ? [
            {
              label: "Temporary password",
              text: x.d.tempPassword,
              html: x.codeValue(x.d.tempPassword),
            },
          ]
        : []),
    ],
  },
  // Deletion requests reuse the governance details block — same "what/where/
  // status" shape, and the reason/note rides in `note` like a review note.
  deletion_requested: {
    heading: (x) => `${x.title} is ${x.meta.subjectWord}`,
    detailsHeader: "Document details",
    linkLabel: "Review the request",
    lineT: (x) =>
      `${x.title} has been flagged for deletion${x.byT}${x.noteT}. Delete it or reject the request from the nest.`,
    lineH: (x) =>
      `${x.doc} has been flagged for deletion${x.byH}${x.noteH}. Delete it or reject the request from the nest.`,
    rows: governanceRows,
  },
  deletion_declined: {
    heading: (x) => `Your deletion request for ${x.title} was rejected`,
    detailsHeader: "Document details",
    linkLabel: "Open document",
    lineT: (x) =>
      `Your request to delete ${x.title} was rejected${x.byT}${x.noteT}. The document stays.`,
    lineH: (x) =>
      `Your request to delete ${x.doc} was rejected${x.byH}${x.noteH}. The document stays.`,
    rows: governanceRows,
  },
  deletion_deleted: {
    heading: (x) => `${x.title} was ${x.meta.subjectWord}`,
    detailsHeader: "Document details",
    linkLabel: "Open nest",
    lineT: (x) =>
      `${x.title} has been deleted${x.byT}${x.noteT} — your deletion request was accepted.`,
    lineH: (x) =>
      `${x.doc} has been deleted${x.byH}${x.noteH} — your deletion request was accepted.`,
    rows: governanceRows,
  },
  deletion_archived: {
    heading: (x) => `${x.title} was ${x.meta.subjectWord}`,
    detailsHeader: "Nest details",
    linkLabel: "Open nest",
    lineT: (x) =>
      `${x.title} has been archived${x.byT}${x.noteT} — your request was accepted. Nothing was deleted: every document and version is intact, and an owner can restore it.`,
    lineH: (x) =>
      `${x.doc} has been archived${x.byH}${x.noteH} — your request was accepted. Nothing was deleted: every document and version is intact, and an owner can restore it.`,
    rows: governanceRows,
  },
  steward: {
    heading: (x) => `You're now a steward of ${x.title}`,
    detailsHeader: "Details",
    linkLabel: "Open nest",
    lineT: (x) =>
      `You've been assigned as a ${x.d.permission || "reviewer"} steward of ${x.d.scopeLabel || x.title}${x.d.by ? ` by ${x.d.by}` : ""}. Open the nest below to start reviewing.`,
    lineH: (x) =>
      `You've been assigned as a <strong>${escapeHtml(x.d.permission || "reviewer")}</strong> steward of ${x.d.scopeLabel ? escapeHtml(x.d.scopeLabel) : x.doc}${x.d.by ? ` by ${escapeHtml(x.d.by)}` : ""}. Open the nest below to start reviewing.`,
    rows: (x) => [
      plainRow("Nest", x.d.path),
      ...(x.d.permission ? [plainRow("Role", cap(x.d.permission))] : []),
      ...(x.d.scopeLabel ? [plainRow("Scope", cap(x.d.scopeLabel))] : []),
    ],
  },
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
  const t = TEMPLATES[d.status];
  const title = d.docTitle.replace(/[\r\n]+/g, " ").trim();
  const vLabel = d.version != null ? `v${d.version}` : "";

  const ctx: RenderCtx = {
    d,
    title,
    doc: `<strong>${escapeHtml(title)}</strong>`,
    byT: d.actor ? ` by ${d.actor}` : "",
    byH: d.actor ? ` by ${escapeHtml(d.actor)}` : "",
    noteT: d.note ? ` with the note: "${d.note}"` : "",
    noteH: d.note ? ` with the note: &ldquo;${escapeHtml(d.note)}&rdquo;` : "",
    vT: vLabel ? ` ${vLabel}` : "",
    vH: vLabel ? ` ${vLabel}` : "",
    meta,
    statusBadge: `<span style="display:inline-block;padding:2px 9px;border-radius:9999px;background:#f3f4f6;color:${meta.color};font-size:12px;font-weight:600;">${meta.label}</span>`,
    codeValue: (v: string) =>
      `<span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:600;color:#111827;background:#f3f4f6;padding:2px 8px;border-radius:6px;">${escapeHtml(v)}</span>`,
  };

  const heading = t.heading(ctx).replace(/[\r\n]+/g, " ").trim();
  const subject = heading;
  const detailsHeader = t.detailsHeader;
  const linkLabel = t.linkLabel;
  const lineH = t.lineH(ctx);
  const rows = t.rows(ctx);

  // Plain-text body: the details header, one "  Label: value" line per row, and
  // a trailing link line.
  const detailLines = [
    `${detailsHeader}:`,
    ...rows.map((r) => `  ${r.label}: ${r.text}`),
    ...(d.link ? [`  ${linkLabel}: ${d.link}`] : []),
  ];
  const text = ["Hi,", "", t.lineT(ctx), "", ...detailLines, "", "Regards,", "Community Nest"].join("\n");

  // HTML detail rows from the same row specs (the value cell is pre-rendered).
  const detailRows = rows.map((r) => detailRow(r.label, r.html)).join("");

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
      Regards,<br>Community Nest
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
  </table>
</div>`;
}
