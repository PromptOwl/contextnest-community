/**
 * /nests/:nestId/hire and /nests/:nestId/agents/recommendations (PO-1201,
 * team chat C10). Experimental: behind EXPERIMENTAL_AGENT_STREAM like
 * channels (app.ts 404s every route here while it is off).
 *
 *   GET    /hire/catalog                      → { catalog: [{ kind, name, …, available, reason }] }  (members)
 *   GET    /hire                              → { hired: [{ kind, handle, hired_by, hired_at, status, … }] }  (members)
 *   POST   /hire { kind, handle?, config?, channels?, announce? } → 201 { hired, created: true, secret? | api_key?, announced }
 *                                               200 { hired, created: false, announced: [] } when it already exists
 *   DELETE /hire/:kind/:handle                → { deleted: true }
 *
 *   GET    /agents/recommendations            → { recommendations: [...] }   (members; at most 5)
 *   POST   /agents/recommendations/:id/dismiss → { dismissed: id }           (the caller's own mark)
 *
 * The handlers are thin: the gates live in service.ts / recommend.ts, which
 * the MCP tools (mcp/hire-tools.ts) call too.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { attributeRequest } from "../shared/client-metadata.js";
import { messageClient } from "../channels/message-meta.js";
import { ValidationError } from "../shared/errors.js";
import { hireAgent, hireCatalog, letAgentGo, listHiredAgents, type HireCaller } from "./service.js";
import { dismissRecommendation, listRecommendations } from "./recommend.js";

export const hireRoutes = new Hono<AuthEnv>();
export const recommendationRoutes = new Hono<AuthEnv>();

async function caller(c: any): Promise<HireCaller> {
  const userId = c.get("userId") as string;
  return {
    nestId: c.req.param("nestId") as string,
    userId,
    userEmail: await resolveCallerEmail(userId),
    nestScoped: !!c.get("nestScope"),
  };
}

async function jsonObject(c: any): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("request body must be a JSON object");
  return body as Record<string, unknown>;
}

hireRoutes.get("/catalog", async (c) => c.json(await hireCatalog(await caller(c))));
hireRoutes.get("/", async (c) => c.json(await listHiredAgents(await caller(c))));

hireRoutes.post("/", async (c) => {
  const body = await jsonObject(c);
  const who = await caller(c);
  const result = await hireAgent(
    // The announcement is the person's own message: a bare key label is
    // kept beside it, never shown as an agent (message-meta.ts), as the
    // annotation route does.
    { ...who, client: messageClient(attributeRequest(c, body.client), body.client, c.get("apiKeyLabel")) },
    { kind: body.kind, handle: body.handle, config: body.config, channels: body.channels, announce: body.announce },
  );
  return c.json(result, result.created ? 201 : 200);
});

hireRoutes.delete("/:kind/:handle", async (c) => c.json(await letAgentGo(await caller(c), c.req.param("kind"), c.req.param("handle"))));

recommendationRoutes.get("/", async (c) => c.json(await listRecommendations(await caller(c))));

recommendationRoutes.post("/:id/dismiss", async (c) => {
  let id = c.req.param("id") as string;
  try {
    id = decodeURIComponent(id);
  } catch {
    /* as given */
  }
  return c.json(await dismissRecommendation(await caller(c), id));
});
