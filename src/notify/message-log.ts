/**
 * Reading the superadmin message log, behind REST GET /admin/messages
 * (message-log-routes.ts).
 *
 * Access is decided by isMessageLogViewer: an effective superadmin, never in
 * open mode (where everyone is admin), never through a nest-scoped key. Every
 * read writes a message_log_views row BEFORE returning data — if the audit
 * can't be written, the read fails — and records which surface it came from.
 */
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { isServerAdminUserId } from "../shared/access.js";
import { pruneMessageLog } from "./outbound-log.js";

export type MessageLogSurface = "rest";

const CHANNELS = ["email", "slack", "msteams", "webhook", "inbox", "comment"];
const SENDER_KINDS = ["human", "persona", "system"];
const STATUSES = ["sent", "failed", "skipped"];

export const MESSAGE_LOG_DENIED = "Only a superadmin can view the message log.";

/**
 * Superadmin, by identity. Open mode never qualifies, and neither does a key
 * scoped to one nest — the log spans every nest.
 */
export async function isMessageLogViewer(
  userId: string | undefined | null,
  nestScope: string | null = null,
): Promise<boolean> {
  if (config.AUTH_MODE === "open" || !userId || nestScope) return false;
  return isServerAdminUserId(userId).catch(() => false);
}

async function audit(
  viewerId: string,
  action: "list" | "detail" | "views",
  filters: Record<string, unknown> | null,
  messageId: string | null,
  via: MessageLogSurface,
): Promise<void> {
  await getDb().run(
    "INSERT INTO message_log_views (id, viewer_id, action, filters_json, message_id, at) VALUES (?, ?, ?, ?, ?, ?)",
    [
      uuid(),
      viewerId,
      action,
      JSON.stringify({ ...(filters ?? {}), via }),
      messageId,
      new Date().toISOString(),
    ],
  );
}

export interface MessageLogFilters {
  channel?: string;
  sender_kind?: string;
  sender?: string;
  status?: string;
  nest?: string;
  run?: string;
  q?: string;
  from?: string;
  to?: string;
}

export interface MessageLogPage {
  limit?: number;
  offset?: number;
}

interface MessageRow {
  id: string;
  channel: string;
  sender_kind: string;
  sender_id: string | null;
  recipients_json: string;
  subject: string | null;
  body_redacted: string | null;
  status: string;
  provider_id: string | null;
  error: string | null;
  nest_id: string | null;
  nest_name?: string | null;
  node_id: string | null;
  run_id: string | null;
  via_proxy: number | null;
  created_at: string;
}

export function clampPage(p: MessageLogPage): { limit: number; offset: number } {
  const l = Number(p.limit);
  const o = Number(p.offset);
  return {
    limit: Number.isFinite(l) ? Math.min(Math.max(Math.trunc(l), 1), 200) : 50,
    offset: Number.isFinite(o) ? Math.max(Math.trunc(o), 0) : 0,
  };
}

function shape(r: MessageRow, withBody: boolean) {
  let recipients: string[] = [];
  try {
    recipients = JSON.parse(r.recipients_json);
  } catch {
    /* malformed row — show none */
  }
  return {
    id: r.id,
    channel: r.channel,
    sender_kind: r.sender_kind,
    sender: r.sender_id,
    recipients,
    subject: r.subject,
    status: r.status,
    provider_id: r.provider_id,
    error: r.error,
    nest_id: r.nest_id,
    nest_name: r.nest_name ?? null,
    node_id: r.node_id,
    run_id: r.run_id,
    via_proxy: r.via_proxy == null ? null : !!r.via_proxy,
    created_at: r.created_at,
    ...(withBody ? { body: r.body_redacted } : { has_body: !!r.body_redacted }),
  };
}

export type MessageLogEntry = ReturnType<typeof shape>;

/** Search the log (newest first). Caller must have passed isMessageLogViewer. */
export async function searchMessageLog(
  viewerId: string,
  raw: MessageLogFilters,
  pageIn: MessageLogPage,
  via: MessageLogSurface,
) {
  const { limit, offset } = clampPage(pageIn);
  const t = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const filters: MessageLogFilters = {
    channel: t(raw.channel),
    sender_kind: t(raw.sender_kind),
    sender: t(raw.sender),
    status: t(raw.status),
    nest: t(raw.nest),
    run: t(raw.run),
    q: t(raw.q),
    from: t(raw.from),
    to: t(raw.to),
  };
  const where: string[] = [];
  const args: string[] = [];
  if (filters.channel && CHANNELS.includes(filters.channel)) {
    where.push("m.channel = ?");
    args.push(filters.channel);
  }
  if (filters.sender_kind && SENDER_KINDS.includes(filters.sender_kind)) {
    where.push("m.sender_kind = ?");
    args.push(filters.sender_kind);
  }
  if (filters.status && STATUSES.includes(filters.status)) {
    where.push("m.status = ?");
    args.push(filters.status);
  }
  if (filters.sender) {
    where.push("LOWER(COALESCE(m.sender_id, '')) LIKE ?");
    args.push(`%${filters.sender.toLowerCase()}%`);
  }
  if (filters.nest) {
    where.push("m.nest_id = ?");
    args.push(filters.nest);
  }
  if (filters.run) {
    where.push("m.run_id = ?");
    args.push(filters.run);
  }
  if (filters.q) {
    where.push("(LOWER(COALESCE(m.subject, '')) LIKE ? OR LOWER(m.recipients_json) LIKE ?)");
    const like = `%${filters.q.toLowerCase()}%`;
    args.push(like, like);
  }
  if (filters.from) {
    where.push("m.created_at >= ?");
    args.push(filters.from);
  }
  if (filters.to) {
    where.push("m.created_at <= ?");
    args.push(filters.to);
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const db = getDb();
  // Sends alone prune only every PRUNE_EVERY inserts; a quiet server must not
  // show bodies past retention.
  await pruneMessageLog().catch(() => {});
  await audit(viewerId, "list", Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), null, via);
  const totalRow = (await db.get(`SELECT COUNT(*) AS n FROM outbound_messages m${whereSql}`, args)) as
    | { n: number }
    | undefined;
  const rows = (await db.all(
    `SELECT m.*, n.name AS nest_name
       FROM outbound_messages m LEFT JOIN nests n ON n.id = m.nest_id
       ${whereSql}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  )) as MessageRow[];
  return {
    total: Number(totalRow?.n ?? 0),
    limit,
    offset,
    retention_days: config.MESSAGE_LOG_RETENTION_DAYS,
    store_bodies: config.MESSAGE_LOG_STORE_BODIES,
    messages: rows.map((r) => shape(r, false)),
  };
}

/** One message with its redacted body, or null. Misses are audited too, so id probing leaves a trace. */
export async function getMessageLogEntry(
  viewerId: string,
  id: string,
  via: MessageLogSurface,
): Promise<MessageLogEntry | null> {
  const row = (await getDb().get(
    `SELECT m.*, n.name AS nest_name
       FROM outbound_messages m LEFT JOIN nests n ON n.id = m.nest_id
      WHERE m.id = ?`,
    [id],
  )) as MessageRow | undefined;
  await audit(viewerId, "detail", null, id, via);
  return row ? shape(row, true) : null;
}

/** The access audit itself (also audited). */
export async function listMessageLogViews(viewerId: string, pageIn: MessageLogPage) {
  const { limit, offset } = clampPage(pageIn);
  const db = getDb();
  await audit(viewerId, "views", null, null, "rest");
  const totalRow = (await db.get("SELECT COUNT(*) AS n FROM message_log_views")) as { n: number } | undefined;
  const rows = (await db.all(
    `SELECT v.id, v.action, v.filters_json, v.message_id, v.at, u.email AS viewer
       FROM message_log_views v LEFT JOIN users u ON u.id = v.viewer_id
      ORDER BY v.at DESC, v.id DESC
      LIMIT ? OFFSET ?`,
    [limit, offset],
  )) as Array<{ id: string; action: string; filters_json: string | null; message_id: string | null; at: string; viewer: string | null }>;
  return {
    total: Number(totalRow?.n ?? 0),
    limit,
    offset,
    views: rows.map((r) => {
      let filters: unknown = null;
      try {
        filters = r.filters_json ? JSON.parse(r.filters_json) : null;
      } catch {
        /* keep null */
      }
      return { id: r.id, viewer: r.viewer, action: r.action, filters, message_id: r.message_id, at: r.at };
    }),
  };
}
