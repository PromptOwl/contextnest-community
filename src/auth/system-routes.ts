/**
 * REST surface for named systems (CU-wdqcq0538g). Every rule lives in
 * auth/systems.ts, shared with the MCP admin tool `context_systems`; these
 * handlers only translate HTTP ↔ service results.
 *
 *   /nests/:nestId/systems                          GET systems working in this nest
 *   /systems                                        GET (all I can manage) · POST create
 *   /systems/:systemId/rotate                       POST
 *   /systems/:systemId                              DELETE revoke
 *   /systems/:systemId/nests                        POST { nest_id } add a nest
 *   /systems/:systemId/nests/:nestId                DELETE remove a nest
 *
 * The plaintext key is returned exactly once, on create/rotate.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthEnv } from "./middleware.js";
import {
  listSystems,
  createSystem,
  rotateSystem,
  revokeSystem,
  addSystemNest,
  removeSystemNest,
  type ServiceResult,
} from "./systems.js";

function send<T extends object>(
  c: Context<AuthEnv>,
  r: ServiceResult<T>,
  pick: (ok: T) => unknown,
  okStatus: 200 | 201 = 200,
) {
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json(pick(r as unknown as T) as Record<string, unknown>, okStatus);
}

const body = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> =>
  ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

// ─── /nests/:nestId/systems ───────────────────────────────────────────────

export const nestSystemRoutes = new Hono<AuthEnv>();

nestSystemRoutes.get("/", async (c) =>
  send(
    c,
    await listSystems({
      actorId: c.get("userId"),
      nestId: c.req.param("nestId")!,
      capability: c.get("keyCapability"),
    }),
    (r) => ({ systems: r.systems }),
  ),
);

// ─── /systems ─────────────────────────────────────────────────────────────

export const systemRoutes = new Hono<AuthEnv>();

systemRoutes.get("/", async (c) =>
  send(
    c,
    await listSystems({ actorId: c.get("userId"), capability: c.get("keyCapability") }),
    (r) => ({ systems: r.systems }),
  ),
);

systemRoutes.post("/", async (c) => {
  const b = await body(c);
  return send(
    c,
    await createSystem({
      actorId: c.get("userId"),
      name: b.name,
      capability: b.capability,
      nestIds: b.nest_ids,
      actorCapability: c.get("keyCapability"),
    }),
    (r) => ({ ...r.system, api_key: r.api_key }),
    201,
  );
});

systemRoutes.post("/:systemId/rotate", async (c) =>
  send(
    c,
    await rotateSystem({
      actorId: c.get("userId"),
      systemId: c.req.param("systemId")!,
      actorCapability: c.get("keyCapability"),
    }),
    (r) => ({ ...r.system, api_key: r.api_key }),
  ),
);

systemRoutes.delete("/:systemId", async (c) =>
  send(
    c,
    await revokeSystem({
      actorId: c.get("userId"),
      systemId: c.req.param("systemId")!,
      actorCapability: c.get("keyCapability"),
    }),
    () => ({ deleted: true }),
  ),
);

systemRoutes.post("/:systemId/nests", async (c) => {
  const b = await body(c);
  return send(
    c,
    await addSystemNest({
      actorId: c.get("userId"),
      systemId: c.req.param("systemId")!,
      nestId: b.nest_id,
      actorCapability: c.get("keyCapability"),
    }),
    (r) => r.system,
  );
});

systemRoutes.delete("/:systemId/nests/:nestId", async (c) =>
  send(
    c,
    await removeSystemNest({
      actorId: c.get("userId"),
      systemId: c.req.param("systemId")!,
      nestId: c.req.param("nestId")!,
      actorCapability: c.get("keyCapability"),
    }),
    (r) => ({ removed: true, system_deleted: r.system_deleted }),
  ),
);
