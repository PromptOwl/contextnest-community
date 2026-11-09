/**
 * /nests/:nestId/agent-webhooks — where an @mention of an agent is delivered
 * (PO-1181, agent team stream S3). Nest owner/admin only, on every method:
 * a target decides where this nest's mention events go.
 *
 *   GET    /agent-webhooks            → { webhooks: [{ handle, target, … }] }  (target = host#hash, never the URL)
 *   PUT    /agent-webhooks/:handle { url, rotate? } → { webhook, secret? }     (secret only when minted)
 *   DELETE /agent-webhooks/:handle    → { deleted: true }
 *
 * The nest middleware (app.ts) already holds these at the admin tier and keeps
 * named system keys out; the handler checks again so the rule lives next to
 * the data. Not on MCP on purpose: wiring where a nest's events go is an
 * admin setting, like /connectors, not an agent's working tool.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { resolveNestAccess } from "../shared/access.js";
import { ForbiddenError, ValidationError } from "../shared/errors.js";
import { deleteAgentWebhook, listAgentWebhooks, putAgentWebhook } from "./agent-webhooks.js";

export const agentWebhookRoutes = new Hono<AuthEnv>();

async function assertNestAdmin(c: any): Promise<{ nestId: string; email: string }> {
  const nestId = c.req.param("nestId") as string;
  const userId = c.get("userId") as string;
  if (config.AUTH_MODE !== "open") {
    const access = await resolveNestAccess(nestId, userId);
    if (access.rawPermission !== "owner" && access.rawPermission !== "admin") {
      throw new ForbiddenError("Only a nest owner or admin can manage agent webhooks.");
    }
    if (access.archived && c.req.method !== "GET") {
      throw new ForbiddenError("This nest is archived, so it is read-only.");
    }
  }
  return { nestId, email: await resolveCallerEmail(userId) };
}

agentWebhookRoutes.get("/", async (c) => {
  const { nestId } = await assertNestAdmin(c);
  return c.json({ webhooks: await listAgentWebhooks(nestId) });
});

agentWebhookRoutes.put("/:handle", async (c) => {
  const { nestId, email } = await assertNestAdmin(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object with a url");
  }
  const b = body as Record<string, unknown>;
  return c.json(await putAgentWebhook(nestId, c.req.param("handle"), { url: b.url, rotate: b.rotate }, email));
});

agentWebhookRoutes.delete("/:handle", async (c) => {
  const { nestId } = await assertNestAdmin(c);
  await deleteAgentWebhook(nestId, c.req.param("handle"));
  return c.json({ deleted: true });
});
