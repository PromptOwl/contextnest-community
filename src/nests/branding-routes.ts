/**
 * PATCH /nests/:nestId/branding — per-nest branding for the public reader and
 * the `/p` published pages (CU-wdqcq02ptm).
 *
 * Who: the nest owner, a nest admin collaborator, or the server admin — the
 * same "admin" tier the access middleware already requires for the
 * visibility and reader-mode resources (app.ts), re-checked here the way the
 * reader-mode handler does. `hide_powered_by` (white-label) is additionally
 * server-admin only.
 *
 * What: the body REPLACES the nest's branding (the settings form always sends
 * its full state); `null` or `{}` clears it. One exception keeps an owner's
 * routine edit from silently undoing the server admin's decision: when a
 * non-admin's body doesn't mention `hide_powered_by`, the stored value is
 * carried over.
 *
 * Read: there is no separate GET — the parsed branding rides GET /nests/:id,
 * which a public reader already fetches (and which 404s a private nest).
 */
import { Hono } from "hono";
import { access as fsAccess } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../db/client.js";
import type { AuthEnv } from "../auth/middleware.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import {
  isServerAdminUserId,
  resolveNestAccess,
  permissionLevel,
} from "../shared/access.js";
import { config } from "../config.js";
import { resolveNestPath } from "../shared/paths.js";
import {
  BrandingValidationError,
  parseStoredBranding,
  validateBrandingInput,
  type NestBranding,
} from "../shared/branding.js";

export const brandingRoutes = new Hono<AuthEnv>();

brandingRoutes.patch("/branding", async (c) => {
  const userId = c.get("userId");
  const nestId = c.req.param("nestId")!;
  const isServerAdmin = config.AUTH_MODE === "open" || (await isServerAdminUserId(userId));
  if (!isServerAdmin) {
    const access = await resolveNestAccess(nestId, userId);
    if (permissionLevel(access.permission) < permissionLevel("admin")) {
      throw new ForbiddenError(
        "Only the nest owner, a nest admin, or the server admin can change branding",
      );
    }
  }

  const db = getDb();
  const row = (await db.get("SELECT branding_json FROM nests WHERE id = ?", [nestId])) as
    | { branding_json: string | null }
    | undefined;
  if (!row) throw new NotFoundError("Nest not found");
  const current = parseStoredBranding(row.branding_json);

  // An empty body is a clear, like null.
  const text = await c.req.text();
  let body: unknown = null;
  if (text.trim() !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ValidationError("body must be JSON");
    }
  }
  if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
    throw new ValidationError("branding must be an object or null");
  }

  const assetsDir = join(resolveNestPath(nestId), "assets");
  let next: NestBranding | null;
  try {
    next = await validateBrandingInput(body, nestId, async (name) => {
      try {
        await fsAccess(join(assetsDir, name));
        return true;
      } catch {
        return false;
      }
    });
  } catch (err) {
    if (err instanceof BrandingValidationError) throw new ValidationError(err.message);
    throw err;
  }

  const wasHidden = current?.hide_powered_by === true;
  const mentionsHide =
    body !== null && Object.prototype.hasOwnProperty.call(body, "hide_powered_by");
  if (!isServerAdmin) {
    if (next?.hide_powered_by === true && !wasHidden) {
      throw new ForbiddenError(
        'Only the server admin can hide the "Powered by ContextNest" line',
      );
    }
    // Carry the admin's white-label choice across an edit that didn't touch it.
    if (next && !mentionsHide && wasHidden) next = { ...next, hide_powered_by: true };
  }

  const stored = next ? JSON.stringify(next) : null;
  await db.run("UPDATE nests SET branding_json = ? WHERE id = ?", [stored, nestId]);
  return c.json({ branding: parseStoredBranding(stored) });
});
