/**
 * /nests/:nestId/fields — custom field definitions (src/nodes/custom-fields.ts).
 *
 * GET is read-tier: anyone who can see the nest needs the definitions to
 * render the values on its documents. Writes are admitted at read tier by the
 * nest middleware (app.ts) and gated HERE by assertCanManageFields — a
 * nest-wide reviewer steward may hold only read collaborator access, and the
 * generic write bump would refuse them before this handler could decide.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import {
  ESTIMATE_UNITS,
  FIELD_PRESETS,
  FIELD_TYPES,
  canManageFields,
  createFieldDefinition,
  deleteFieldDefinition,
  listFieldDefinitionEvents,
  listFieldDefinitions,
  nodesWithInvalidValues,
  updateFieldDefinition,
} from "../nodes/custom-fields.js";
import { ValidationError } from "../shared/errors.js";

export const fieldRoutes = new Hono<AuthEnv>();

async function jsonObject(c: { req: { json: () => Promise<unknown> } }) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError("request body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

fieldRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  return c.json({
    fields: await listFieldDefinitions(nestId),
    can_manage: await canManageFields(nestId, c.get("userId")),
    types: FIELD_TYPES,
    presets: FIELD_PRESETS,
    estimate_units: ESTIMATE_UNITS,
  });
});

// Who changed which definition, before → after. Read-tier like the list:
// the definitions govern every write, so their history is everyone's to see.
fieldRoutes.get("/history", async (c) => {
  const limit = Number(c.req.query("limit") ?? 100);
  return c.json({
    events: await listFieldDefinitionEvents(c.req.param("nestId")!, Number.isFinite(limit) ? limit : 100),
  });
});

fieldRoutes.post("/", async (c) => {
  const body = await jsonObject(c);
  const field = await createFieldDefinition(c.req.param("nestId")!, c.get("userId"), body);
  return c.json({ field }, 201);
});

fieldRoutes.patch("/:fieldId", async (c) => {
  const body = await jsonObject(c);
  const field = await updateFieldDefinition(
    c.req.param("nestId")!,
    c.req.param("fieldId")!,
    c.get("userId"),
    body,
  );
  // Narrowing options or applies_to can leave values on documents that no
  // longer validate. They stay (governed history), but the admin is told.
  const invalid = await nodesWithInvalidValues(c.req.param("nestId")!, field);
  return c.json({ field, invalid_values: invalid.length, invalid_nodes: invalid.slice(0, 50) });
});

fieldRoutes.delete("/:fieldId", async (c) => {
  const field = await deleteFieldDefinition(
    c.req.param("nestId")!,
    c.req.param("fieldId")!,
    c.get("userId"),
  );
  return c.json({ deleted: true, field });
});
