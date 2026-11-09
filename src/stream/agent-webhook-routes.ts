/**
 * /nests/:nestId/agent-webhooks — where an @mention of an agent is delivered
 * (PO-1181, agent team stream S3). Nest owner/admin only, on every method:
 * a target decides where this nest's mention events go.
 *
 *   GET    /agent-webhooks            → { webhooks: [{ handle, target, …, last_delivery }] }  (target = host#hash, never the URL)
 *   PUT    /agent-webhooks/:handle { url?, rotate? } → { webhook, secret? }    (secret only when minted;
 *                                       url may be left out for a handle that has one — rotate from the row)
 *   POST   /agent-webhooks/:handle/test → { ok, delivery, webhook }            (one signed agent.test POST; 429 past the limit)
 *   DELETE /agent-webhooks/:handle    → { deleted: true }
 *
 * The nest middleware (app.ts) already holds these at the admin tier and keeps
 * named system keys out; the handler checks again so the rule lives next to
 * the data (assertCanManageAgentWebhooks, shared with MCP). MCP twin:
 * context_agent_webhooks (list / set / delete), same service, same objects.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { ValidationError } from "../shared/errors.js";
import {
  assertCanManageAgentWebhooks,
  deleteAgentWebhook,
  listAgentWebhooks,
  putAgentWebhook,
  testAgentWebhook,
} from "./agent-webhooks.js";

export const agentWebhookRoutes = new Hono<AuthEnv>();

async function assertNestAdmin(c: any): Promise<{ nestId: string; email: string }> {
  const nestId = c.req.param("nestId") as string;
  const userId = c.get("userId") as string;
  await assertCanManageAgentWebhooks(nestId, userId, { write: c.req.method !== "GET" });
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
    throw new ValidationError("request body must be a JSON object: { url } to save a target, { rotate: true } for a new secret");
  }
  const b = body as Record<string, unknown>;
  return c.json(await putAgentWebhook(nestId, c.req.param("handle"), { url: b.url, rotate: b.rotate }, email));
});

agentWebhookRoutes.post("/:handle/test", async (c) => {
  const { nestId, email } = await assertNestAdmin(c);
  return c.json(await testAgentWebhook(nestId, c.req.param("handle"), email));
});

agentWebhookRoutes.delete("/:handle", async (c) => {
  const { nestId } = await assertNestAdmin(c);
  await deleteAgentWebhook(nestId, c.req.param("handle"));
  return c.json({ deleted: true });
});
