/**
 * REST for Nest Plugins (Slice A, CU-wdqcq05raz), mounted at
 * /nests/:nestId/plugins. Thin: every rule lives in service.ts, which the MCP
 * tools call too. Gated by FEATURE_PLUGINS (404 when off).
 *
 *   GET    /                 loaded plugins + this nest's config (read)
 *   PUT    /:name            configure / enable / disable (nest admin)
 *   DELETE /:name            forget config, secrets, system identity (nest admin)
 *   POST   /:name/run        run now (write)
 *   GET    /:name/runs       run ledger (read; error text at write)
 *   GET    /:name/health     plugin healthcheck with resolved settings (read)
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import { ValidationError } from "../shared/errors.js";
import {
  configurePlugin,
  listNestPlugins,
  listPluginRuns,
  pluginHealth,
  removePlugin,
  runPluginNow,
  type Caller,
} from "./service.js";

export const requirePlugins = async (c: any, next: () => Promise<void>) => {
  if (!config.FEATURE_PLUGINS) return c.json({ error: "Not found" }, 404);
  await next();
};

const caller = (c: any): Caller => ({
  userId: String(c.get("userId")),
  capability: c.get("keyCapability") === "read" ? "read" : "write",
});

export const pluginNestRoutes = new Hono<AuthEnv>();

pluginNestRoutes.get("/", requirePlugins, async (c) => c.json(await listNestPlugins(c.req.param("nestId")!, caller(c))));

pluginNestRoutes.put("/:name", requirePlugins, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => {
    throw new ValidationError("Invalid JSON body");
  });
  return c.json(await configurePlugin(c.req.param("nestId")!, c.req.param("name")!, body ?? {}, caller(c)));
});

pluginNestRoutes.delete("/:name", requirePlugins, async (c) =>
  c.json(await removePlugin(c.req.param("nestId")!, c.req.param("name")!, caller(c))),
);

pluginNestRoutes.post("/:name/run", requirePlugins, async (c) =>
  c.json(await runPluginNow(c.req.param("nestId")!, c.req.param("name")!, caller(c))),
);

pluginNestRoutes.get("/:name/runs", requirePlugins, async (c) =>
  c.json(await listPluginRuns(c.req.param("nestId")!, c.req.param("name")!, caller(c), Number(c.req.query("limit") ?? 20))),
);

pluginNestRoutes.get("/:name/health", requirePlugins, async (c) =>
  c.json(await pluginHealth(c.req.param("nestId")!, c.req.param("name")!, caller(c))),
);
