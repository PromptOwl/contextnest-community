/**
 * /admin/messages — the superadmin message log. Every message the server sent
 * (email, Slack/Teams/connector webhooks, in-app inbox, persona and Hootie
 * comments), with filters, a detail view, and an access audit.
 *
 * SUPERADMIN ONLY. Stricter than the other /admin/* surfaces: those accept
 * AUTH_MODE=open (everyone is admin there); this one never does, because the
 * log holds other people's messages across every nest. Nest admins and owners
 * are refused. Every read is written to message_log_views — who looked, at
 * what, with which filters — and that audit is itself superadmin-only.
 */
import { Hono, type Context } from "hono";
import { v4 as uuid } from "uuid";
import type { AuthEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { isServerAdminUserId } from "../shared/access.js";

export const messageLogRoutes = new Hono<AuthEnv>();

const CHANNELS = ["email", "slack", "msteams", "webhook", "inbox", "comment"];
const SENDER_KINDS = ["human", "persona", "system"];
const STATUSES = ["sent", "failed", "skipped"];

/** Superadmin, by identity. Open mode never qualifies. */
export async function isMessageLogViewer(userId: string | undefined): Promise<boolean> {
  if (config.AUTH_MODE === "open" || !userId) return false;
  return isServerAdminUserId(userId).catch(() => false);
}

async function requireSuperadmin(c: Context<AuthEnv>): Promise<Response | null> {
  if (await isMessageLogViewer(c.get("userId"))) return null;
  return c.json({ error: "Only a superadmin can view the message log." }, 403);
}

async function audit(
  viewerId: string,
  action: "list" | "detail" | "views",
  filters: Record<string, unknown> | null,
  messageId: string | null,
): Promise<void> {
  // Unlike the outbound log, the view audit is NOT best-effort: if we can't
  // record who looked, the caller doesn't get to look.
  await getDb().run(
    "INSERT INTO message_log_views (id, viewer_id, action, filters_json, message_id, at) VALUES (?, ?, ?, ?, ?, ?)",
    [uuid(), viewerId, action, filters ? JSON.stringify(filters) : null, messageId, new Date().toISOString()],
  );
}

function page(c: Context<AuthEnv>): { limit: number; offset: number } {
  const l = Number(c.req.query("limit"));
  const o = Number(c.req.query("offset"));
  return {
    limit: Number.isFinite(l) ? Math.min(Math.max(Math.trunc(l), 1), 200) : 50,
    offset: Number.isFinite(o) ? Math.max(Math.trunc(o), 0) : 0,
  };
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

// GET /admin/messages?channel=&sender_kind=&sender=&status=&nest=&run=&q=&from=&to=&limit=&offset=
messageLogRoutes.get("/", async (c) => {
  const denied = await requireSuperadmin(c);
  if (denied) return denied;
  const { limit, offset } = page(c);
  const q = (k: string) => c.req.query(k)?.trim() || undefined;
  const filters = {
    channel: q("channel"),
    sender_kind: q("sender_kind"),
    sender: q("sender"),
    status: q("status"),
    nest: q("nest"),
    run: q("run"),
    q: q("q"),
    from: q("from"),
    to: q("to"),
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
  await audit(c.get("userId"), "list", Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), null);
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
  return c.json({
    total: Number(totalRow?.n ?? 0),
    limit,
    offset,
    retention_days: config.MESSAGE_LOG_RETENTION_DAYS,
    store_bodies: config.MESSAGE_LOG_STORE_BODIES,
    messages: rows.map((r) => shape(r, false)),
  });
});

// GET /admin/messages/views — who read the log. Registered before /:id.
messageLogRoutes.get("/views", async (c) => {
  const denied = await requireSuperadmin(c);
  if (denied) return denied;
  const { limit, offset } = page(c);
  const db = getDb();
  await audit(c.get("userId"), "views", null, null);
  const totalRow = (await db.get("SELECT COUNT(*) AS n FROM message_log_views")) as { n: number } | undefined;
  const rows = (await db.all(
    `SELECT v.id, v.action, v.filters_json, v.message_id, v.at, u.email AS viewer
       FROM message_log_views v LEFT JOIN users u ON u.id = v.viewer_id
      ORDER BY v.at DESC, v.id DESC
      LIMIT ? OFFSET ?`,
    [limit, offset],
  )) as Array<{ id: string; action: string; filters_json: string | null; message_id: string | null; at: string; viewer: string | null }>;
  return c.json({
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
  });
});

// GET /admin/messages/:id — one message with its (redacted) body.
messageLogRoutes.get("/:id", async (c) => {
  const denied = await requireSuperadmin(c);
  if (denied) return denied;
  const id = c.req.param("id");
  const row = (await getDb().get(
    `SELECT m.*, n.name AS nest_name
       FROM outbound_messages m LEFT JOIN nests n ON n.id = m.nest_id
      WHERE m.id = ?`,
    [id],
  )) as MessageRow | undefined;
  if (!row) return c.json({ error: "Message not found." }, 404);
  await audit(c.get("userId"), "detail", null, id);
  return c.json({ message: shape(row, true) });
});
