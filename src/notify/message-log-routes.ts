/**
 * /admin/messages — the superadmin message log over REST. Every message the
 * server sent (email, Slack/Teams/connector webhooks, in-app inbox, persona
 * and Hootie comments), with filters, a detail view, and an access audit.
 *
 * SUPERADMIN ONLY. Stricter than the other /admin/* surfaces: those accept
 * AUTH_MODE=open (everyone is admin there); this one never does, because the
 * log holds other people's messages across every nest. Nest admins, owners
 * and nest-scoped keys are refused. Every read is audited — see
 * message-log.ts, which the MCP tools share.
 */
import { Hono, type Context } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import {
  MESSAGE_LOG_DENIED,
  getMessageLogEntry,
  isMessageLogViewer,
  listMessageLogViews,
  searchMessageLog,
} from "./message-log.js";

export { isMessageLogViewer };

export const messageLogRoutes = new Hono<AuthEnv>();

async function denied(c: Context<AuthEnv>): Promise<Response | null> {
  if (await isMessageLogViewer(c.get("userId"), c.get("nestScope") ?? null)) return null;
  return c.json({ error: MESSAGE_LOG_DENIED }, 403);
}

// GET /admin/messages?channel=&sender_kind=&sender=&status=&nest=&run=&q=&from=&to=&limit=&offset=
messageLogRoutes.get("/", async (c) => {
  const refusal = await denied(c);
  if (refusal) return refusal;
  const q = c.req.query();
  return c.json(
    await searchMessageLog(c.get("userId"), q, { limit: Number(q.limit), offset: Number(q.offset) }, "rest"),
  );
});

// GET /admin/messages/views — who read the log. Registered before /:id.
messageLogRoutes.get("/views", async (c) => {
  const refusal = await denied(c);
  if (refusal) return refusal;
  return c.json(
    await listMessageLogViews(c.get("userId"), {
      limit: Number(c.req.query("limit")),
      offset: Number(c.req.query("offset")),
    }),
  );
});

// GET /admin/messages/:id — one message with its (redacted) body.
messageLogRoutes.get("/:id", async (c) => {
  const refusal = await denied(c);
  if (refusal) return refusal;
  const message = await getMessageLogEntry(c.get("userId"), c.req.param("id"), "rest");
  if (!message) return c.json({ error: "Message not found." }, 404);
  return c.json({ message });
});
