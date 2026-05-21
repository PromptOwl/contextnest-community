import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveNestPermission } from "../shared/access.js";
import {
  createNest,
  listNests,
  listSharedNests,
  getNest,
  deleteNest,
  isStewardshipEnabled,
  setStewardshipEnabled,
} from "./service.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { isLicenseAdminUserId } from "../auth/license.js";
import { ANON_USER_ID } from "../shared/constants.js";

/**
 * Effective permission for a nest, honoring open-mode + anon-owned nests.
 *
 * In open mode, the access-control middleware grants everyone "owner" at
 * the route level, but per-handler checks run resolveNestPermission fresh
 * against the DB. If the caller has a stale Bearer token (non-anon user),
 * the DB check says "none" and the handler 404s even though the middleware
 * let the request through. Symptom: toggling stewardship on an anon-owned
 * nest silently fails when a real-user token is present in localStorage.
 *
 * Rule: in open mode, anon-owned nests are the ungoverned commons —
 * anyone is effectively the owner.
 */
function effectivePermission(nestId: string, userId: string) {
  if (config.AUTH_MODE === "open") {
    const db = getDb();
    const nest = db
      .prepare("SELECT user_id FROM nests WHERE id = ?")
      .get(nestId) as { user_id: string } | undefined;
    if (nest && nest.user_id === ANON_USER_ID) return "owner" as const;
  }
  return resolveNestPermission(nestId, userId);
}

export const nestRoutes = new Hono<AuthEnv>();

// GET /nests
nestRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const owned = listNests(userId);
  const shared = listSharedNests(userId);
  // Annotate each row with the caller's effective permission so the UI
  // can render an accurate share line and gate destructive actions
  // (delete) on owner-only without an extra round-trip per card.
  // `effectivePermission` already handles the open-mode anon nest case
  // where everyone is the owner. For shared nests we also resolve the
  // owner's email so the card can show "shared by …" instead of a
  // bare badge.
  const db = getDb();
  const ownerEmailStmt = db.prepare(
    "SELECT email FROM users WHERE id = ?",
  );
  const annotate = (n: { id: string; user_id: string }) => {
    const permission = effectivePermission(n.id, userId);
    const is_owner = permission === "owner";
    let owner_email: string | null = null;
    if (!is_owner && n.user_id !== ANON_USER_ID) {
      const row = ownerEmailStmt.get(n.user_id) as
        | { email?: string }
        | undefined;
      owner_email = row?.email ?? null;
    }
    return { ...n, permission, is_owner, owner_email };
  };
  return c.json({
    nests: [...owned.map(annotate), ...shared.map(annotate)],
  });
});

// POST /nests
nestRoutes.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; description?: string }>();
  if (!body.name) {
    throw new ValidationError("name is required");
  }

  const nest = await createNest(c.get("userId"), body.name, body.description);
  return c.json({ nest }, 201);
});

// GET /nests/:nestId
nestRoutes.get("/:nestId", async (c) => {
  const nestId = c.req.param("nestId")!;
  const permission = effectivePermission(nestId, c.get("userId"));
  if (permission === "none") {
    throw new NotFoundError("Nest not found");
  }

  const nest = getNest(nestId);
  return c.json({ nest, permission });
});

// DELETE /nests/:nestId
nestRoutes.delete("/:nestId", async (c) => {
  const nestId = c.req.param("nestId")!;
  const permission = effectivePermission(nestId, c.get("userId"));
  if (permission !== "owner") {
    throw new NotFoundError("Nest not found");
  }

  await deleteNest(nestId);
  return c.json({ deleted: true });
});

// GET /nests/:nestId/settings — read nest settings (stewardship enabled, etc.)
nestRoutes.get("/:nestId/settings", async (c) => {
  const nestId = c.req.param("nestId")!;
  const permission = effectivePermission(nestId, c.get("userId"));
  if (permission === "none") {
    throw new NotFoundError("Nest not found");
  }
  return c.json({
    stewardship_enabled: isStewardshipEnabled(nestId),
  });
});

// PATCH /nests/:nestId/settings — update settings (admin-only)
nestRoutes.patch("/:nestId/settings", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");

  // Must be server admin OR nest owner
  const isServerAdmin = isLicenseAdminUserId(userId);
  const permission = effectivePermission(nestId, userId);

  if (!isServerAdmin && permission !== "owner") {
    return c.json(
      {
        error:
          "Only the nest owner or the server license-admin can update nest settings.",
      },
      403,
    );
  }

  const body = await c.req.json<{ stewardship_enabled?: boolean }>();
  if (typeof body.stewardship_enabled === "boolean") {
    setStewardshipEnabled(nestId, body.stewardship_enabled);
  }

  return c.json({
    stewardship_enabled: isStewardshipEnabled(nestId),
  });
});
