/**
 * Review SLA escalation — a review nobody picks up climbs the steward ladder.
 *
 * Per-nest `review_sla_hours` (NULL = off, the default). When set, a review
 * left pending that long escalates ONE rung, and each rung gets the same
 * window before the next:
 *
 *   rung 0  document-scope reviewers   (notified at submit, as always)
 *   rung 1  tag-scope reviewers
 *   rung 2  nest-scope reviewers
 *   rung 3  the nest owner
 *
 * Escalating notifies the new rung through the paths every other governance
 * event uses — an inbox row, the connector dispatch (Slack/Teams/webhook) and
 * a direct email when SMTP is configured — and records the rung on the review
 * row (`escalation_level`, `escalated_at`). That record is the idempotency:
 * the rung is CLAIMED with a conditional UPDATE before anyone is notified, so
 * a second tick, a restart, or a second server instance racing this one can
 * never notify the same rung twice. The trade is at-most-once: a crash between
 * the claim and the send loses that rung's ping rather than repeating it.
 *
 * Escalation only widens who HEARS about a review. It grants nothing: who may
 * approve is still canUserApprove, and separation of duties is untouched — the
 * submitter is never an escalation recipient, since they can't approve it.
 *
 * A rung with nobody new on it (no tag reviewers on this document, say) is
 * skipped in the same step, so one escalation always reaches someone if anyone
 * is left. Someone already on a lower rung isn't paged again by a higher one.
 *
 * Runs on its own interval rather than the workflow scheduler: that loop only
 * starts with FEATURE_WORKFLOW_PLANE on, and review governance doesn't depend
 * on the workflow plane.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { resolveStewardsForNode } from "./stewardship-service.js";
import { canOpenNode } from "./mention-notify.js";
import { buildDocContext } from "./title-resolver.js";
import { dispatchEvent } from "../notify/dispatch.js";
import { notifyNestEvent } from "../notify/notify.js";
import { sendEmailToRecipient } from "../notify/email.js";

/** The last rung: the nest owner. Nothing escalates past it. */
export const MAX_ESCALATION_LEVEL = 3;

export const ESCALATION_RUNG_LABELS: Record<number, string> = {
  1: "tag reviewers",
  2: "nest reviewers",
  3: "nest owner",
};

interface PendingRow {
  id: string;
  nest_id: string;
  node_id: string;
  version: number;
  requested_by: string;
  requested_at: string;
  escalation_level: number | null;
  escalated_at: string | null;
  review_sla_hours: number;
  owner_email: string | null;
}

/**
 * Parse a stored timestamp to epoch ms. The DB default is SQLite-style
 * `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker (both drivers write that
 * shape), which Date.parse would read as LOCAL time — so it is pinned to UTC
 * here. ISO strings with a zone pass through unchanged.
 */
export function parseDbTimestamp(s: string | null | undefined): number {
  if (!s) return NaN;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`;
  return Date.parse(zoned);
}

/** Stored-timestamp format, so escalated_at compares like requested_at. */
function dbTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Who each rung reaches for this document, lowercased. Rung 0 (document
 * reviewers) is included only so higher rungs can exclude its people.
 *
 * Rungs come from resolveStewardsForNode's `priority`, which is the scope the
 * steward matched on: 1 = a document pattern, 2 = a tag on the document,
 * 3 = nest-level (see the UNION in stewardship-service). Only `reviewer`
 * stewards count — an `owner`-role steward doesn't review.
 *
 * Every rung is filtered to people who can open the document right now (the
 * same canOpenNode gate mentions and comment notifications use): a steward
 * row can outlive the access behind it, and an escalation names the document.
 * A rung left empty by that filter is skipped like any other empty rung.
 */
async function rungMembers(
  nestId: string,
  nodeId: string,
  ownerEmail: string | null,
): Promise<string[][]> {
  const stewards = await resolveStewardsForNode(nestId, nodeId);
  const byPriority = (p: number) => [
    ...new Set(
      stewards
        .filter((s) => s.priority === p && s.steward.role === "reviewer")
        .map((s) => s.steward.userEmail.toLowerCase()),
    ),
  ];
  const rungs = [
    byPriority(1), // document
    byPriority(2), // tag
    byPriority(3), // nest
    ownerEmail ? [ownerEmail.toLowerCase()] : [],
  ];
  const allowed = await canOpenAll(nestId, nodeId, [...new Set(rungs.flat())]);
  return rungs.map((rung) => rung.filter((e) => allowed.has(e)));
}

/** The subset of `emails` that belong to an account able to open the node. */
async function canOpenAll(nestId: string, nodeId: string, emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const users = (await getDb().all(
    `SELECT id, LOWER(email) AS email FROM users
      WHERE LOWER(email) IN (${emails.map(() => "?").join(",")})`,
    emails,
  )) as Array<{ id: string; email: string }>;
  const checked = await Promise.all(
    users.map(async (u) => ((await canOpenNode(nestId, nodeId, u.id, u.email)) ? u.email : null)),
  );
  return new Set(checked.filter((e): e is string => e !== null));
}

/**
 * The next rung above `level` with anyone new on it: its members minus the
 * submitter and minus everyone on a lower rung. `null` when no rung is left.
 */
export function nextRung(
  rungs: string[][],
  level: number,
  submitter: string,
): { level: number; recipients: string[] } | null {
  const sub = submitter.toLowerCase();
  const below = new Set<string>();
  for (let i = 0; i <= level && i < rungs.length; i++) {
    for (const e of rungs[i]) below.add(e);
  }
  for (let next = level + 1; next <= MAX_ESCALATION_LEVEL; next++) {
    const recipients = (rungs[next] ?? []).filter(
      (e) => e !== sub && !below.has(e),
    );
    if (recipients.length > 0) return { level: next, recipients };
    for (const e of rungs[next] ?? []) below.add(e);
  }
  return null;
}

/** Notify one rung. Best-effort per channel: a failed send never un-claims. */
async function notifyEscalation(
  r: PendingRow,
  level: number,
  recipients: string[],
  hoursWaiting: number,
): Promise<void> {
  const db = getDb();
  const ctx = await buildDocContext(r.nest_id, r.node_id);
  const waited = `${hoursWaiting} hour${hoursWaiting === 1 ? "" : "s"}`;
  const nowIso = new Date().toISOString();
  for (const email of recipients) {
    await db.run(
      `INSERT INTO notifications (id, nest_id, user_email, kind, subject_id, message, created_at)
       VALUES (?, ?, ?, 'review_escalated', ?, ?, ?)`,
      [
        uuid(),
        r.nest_id,
        email,
        // The review id, like review_requested rows: listNotifications joins
        // review_requests on it to link the document.
        r.id,
        `"${ctx.label}" has been waiting ${waited} for review (submitted by ${r.requested_by}) — escalated to you`,
        nowIso,
      ],
    );
  }
  const line = `Review on *${ctx.label}* (v${r.version}) has waited ${waited} — escalated to ${ESCALATION_RUNG_LABELS[level]}: ${recipients.join(", ")}`;
  // Same two channel paths a review request takes: per-nest connector rows
  // that subscribe to review_escalated (or "*") via dispatchEvent, and the
  // server-wide Slack/Teams webhooks via the debounced digest — which is the
  // default every nest gets with no connector rows at all. review_escalated is
  // a digest kind, so dispatchEvent skips the server-wide hooks and the
  // channel sees it once.
  void dispatchEvent({
    kind: "review_escalated",
    nestId: r.nest_id,
    subjectId: r.node_id,
    actor: r.requested_by,
    message: line,
  });
  // skipEmail: the escalated reviewers are emailed directly below, and the
  // "escalated to you" email is not for the shared team inbox.
  void notifyNestEvent(r.nest_id, `:alarm_clock: ${line}`, undefined, {
    skipEmail: true,
  });
  void sendEmailToRecipient(recipients, {
    status: "review_overdue",
    docTitle: ctx.docTitle,
    path: ctx.path,
    link: ctx.link,
    actor: r.requested_by,
    version: r.version,
    // The template already says it passed the SLA and was escalated; a note
    // would render as "with the note: …", which reads as the submitter's words.
    note: null,
  });
}

/**
 * One pass over every overdue pending review in a nest with an SLA set.
 * Exported for tests (pass a fake `now`). Returns what it escalated. Each
 * review fails independently — one bad row must not stall the rest.
 */
export async function reviewSlaTick(
  now: number = Date.now(),
): Promise<Array<{ reviewId: string; level: number; recipients: string[] }>> {
  const db = getDb();
  // Nests with the SLA off never match: review_sla_hours IS NULL fails `> 0`.
  // Ungoverned nests have no reviewers to escalate to, and archived nests are
  // put away — the workflow scheduler skips them for the same reason.
  const rows = (await db.all(
    `SELECT r.id, r.nest_id, r.node_id, r.version, r.requested_by, r.requested_at,
            r.escalation_level, r.escalated_at, n.review_sla_hours,
            u.email AS owner_email
       FROM review_requests r
       JOIN nests n ON n.id = r.nest_id
       LEFT JOIN users u ON u.id = n.user_id
      WHERE r.status = 'pending'
        AND n.review_sla_hours > 0
        AND n.stewardship_enabled = 1
        AND n.archived_at IS NULL
        AND COALESCE(r.escalation_level, 0) < ?`,
    [MAX_ESCALATION_LEVEL],
  )) as PendingRow[];

  const escalated: Array<{ reviewId: string; level: number; recipients: string[] }> = [];
  for (const r of rows) {
    try {
      const level = Number(r.escalation_level ?? 0);
      const windowMs = Number(r.review_sla_hours) * 3_600_000;
      // Each rung gets a full window: measured from the last escalation, or
      // from submission for the first.
      const since = parseDbTimestamp(r.escalated_at ?? r.requested_at);
      if (!Number.isFinite(since) || now - since < windowMs) continue;

      const rungs = await rungMembers(r.nest_id, r.node_id, r.owner_email);
      const next = nextRung(rungs, level, r.requested_by);
      // Nobody left to tell: park the review at the top rung so the tick
      // stops re-resolving it every minute. Nothing is sent.
      const target = next?.level ?? MAX_ESCALATION_LEVEL;

      // Claim the rung. Only the caller whose UPDATE moves the level from
      // what it read gets to notify — the idempotency guarantee.
      const claim = await db.run(
        `UPDATE review_requests
            SET escalation_level = ?, escalated_at = ?
          WHERE id = ? AND status = 'pending' AND COALESCE(escalation_level, 0) = ?`,
        [target, dbTimestamp(now), r.id, level],
      );
      if (claim.changes !== 1 || !next) continue;

      const requestedAt = parseDbTimestamp(r.requested_at);
      const hoursWaiting = Math.max(
        1,
        Math.floor((now - (Number.isFinite(requestedAt) ? requestedAt : since)) / 3_600_000),
      );
      try {
        await notifyEscalation(r, next.level, next.recipients, hoursWaiting);
      } catch (err) {
        console.error("[review-sla] escalation notify failed", r.id, err);
      }
      escalated.push({ reviewId: r.id, level: next.level, recipients: next.recipients });
    } catch (err) {
      console.error("[review-sla] failed to escalate review", r.id, err);
    }
  }
  return escalated;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the escalation loop (60s). Always on: with no nest setting an SLA the
 * tick is one SELECT that matches nothing. Unref'd so it never holds the
 * process open.
 */
export function startReviewSlaLoop(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    void reviewSlaTick().catch((err) =>
      console.error("[review-sla] tick failed", err),
    );
  }, intervalMs);
  timer.unref?.();
}

export function stopReviewSlaLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
