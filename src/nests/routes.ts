import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveNestPermission } from "../shared/access.js";
import {
  createNest,
  importNest,
  listNests,
  listSharedNests,
  listPublicNests,
  getNest,
  deleteNest,
  renameNest,
  isStewardshipEnabled,
  setStewardshipEnabled,
  disableStewardshipAndWipeGovernance,
  nestAllowsSelfApprove,
  setAllowSelfApprove,
} from "./service.js";
import { registerImportedDocuments } from "../nodes/service.js";
import {
  listUnsyncedFolders,
  syncUnsyncedFolder,
} from "./unsynced-service.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../shared/errors.js";
import {
  resolveUserRoles,
  getStewardsForUser,
  getCollaboratorRole,
  getStewardRolesForUser,
} from "../governance/stewardship-service.js";
import { collabPermToRole } from "../governance/roles.js";
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
async function effectivePermission(nestId: string, userId: string) {
  if (config.AUTH_MODE === "open") {
    const db = getDb();
    const nest = (await db.get(
      "SELECT user_id FROM nests WHERE id = ?",
      [nestId],
    )) as { user_id: string } | undefined;
    if (nest && nest.user_id === ANON_USER_ID) return "owner" as const;
  }
  return resolveNestPermission(nestId, userId);
}

export const nestRoutes = new Hono<AuthEnv>();

// GET /nests
nestRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  const owned = await listNests(userId);
  // Collaborator/steward grants are independent of stewardship — a shared
  // nest stays visible whether or not governed mode is on.
  const shared = await listSharedNests(userId);
  // Public-but-not-mine; surfaces them in dashboard list.
  const publicExtras = await listPublicNests(userId);

  // Annotate each row with the caller's effective permission so the UI
  // can render an accurate share line and gate destructive actions
  // (delete) on owner-only without an extra round-trip per card.
  // `effectivePermission` already handles the open-mode anon nest case
  // where everyone is the owner. For shared nests we also resolve the
  // owner's email so the card can show "shared by …" instead of a
  // bare badge.
  const db = getDb();
  const ownerEmailSql = "SELECT email FROM users WHERE id = ?";
  // Resolve the caller's email once so we can merge steward roles into the
  // per-card label. A steward (editor/reviewer) without a collaborator grant
  // resolves to permission='read' (see resolveNestPermission), so the card
  // would mislabel them "Viewer" unless we surface their steward roles too.
  const callerEmail = await resolveCallerEmail(userId);
  const annotate = async (n: { id: string; user_id: string }) => {
    const permission = await effectivePermission(n.id, userId);
    const is_owner = permission === "owner";
    let owner_email: string | null = null;
    // Role badge on shared cards. Derive from the caller's ACTUAL grant on
    // this nest (collaborator row + steward rows), NOT resolveUserRoles —
    // that folds a license/super admin to "admin" on every nest, so a server
    // admin who is only an editor collaborator here would be mislabeled
    // "Admin" on a nest they don't own. getCollaboratorRole reads the raw
    // grant, so the badge shows their real relationship.
    let roles: string[];
    if (is_owner) {
      roles = ["owner"];
    } else {
      const grantRole = collabPermToRole(
        await getCollaboratorRole(n.id, callerEmail),
      );
      const stewardRoles = await getStewardRolesForUser(n.id, callerEmail);
      roles = [
        ...new Set([grantRole, ...stewardRoles].filter(Boolean) as string[]),
      ];
    }
    if (!is_owner && n.user_id !== ANON_USER_ID) {
      const row = (await db.get(ownerEmailSql, [n.user_id])) as
        | { email?: string }
        | undefined;
      owner_email = row?.email ?? null;
    }
    return { ...n, permission, is_owner, owner_email, roles };
  };
  // Dedupe by id; owner/shared rows win over public discovery row.
  const seen = new Set<string>();
  const out: Awaited<ReturnType<typeof annotate>>[] = [];
  for (const n of [...owned, ...shared, ...publicExtras]) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(await annotate(n));
  }

  // Tile metadata: per-nest document count + people (collaborators + active
  // stewards). All three are single grouped queries rather than per-nest
  // work — the doc count uses node_versions (every live doc, API-created or
  // imported, is registered there; deletes remove its rows) so listing stays
  // one round-trip instead of a filesystem scan per card on every load.
  const docRows = (await db.all(
    "SELECT nest_id, COUNT(DISTINCT node_id) AS c FROM node_versions GROUP BY nest_id",
  )) as Array<{ nest_id: string; c: number }>;
  const docByNest = new Map(docRows.map((r) => [r.nest_id, r.c]));
  const collabRows = (await db.all(
    "SELECT nest_id, COUNT(*) AS c FROM nest_collaborators GROUP BY nest_id",
  )) as Array<{ nest_id: string; c: number }>;
  const collabByNest = new Map(collabRows.map((r) => [r.nest_id, r.c]));
  const stewardRows = (await db.all(
    "SELECT nest_id, COUNT(DISTINCT user_email) AS c FROM stewards WHERE is_active = 1 GROUP BY nest_id",
  )) as Array<{ nest_id: string; c: number }>;
  const stewardByNest = new Map(stewardRows.map((r) => [r.nest_id, r.c]));
  const withMeta = out.map((n) => ({
    ...n,
    document_count: docByNest.get(n.id) ?? 0,
    collaborator_count: collabByNest.get(n.id) ?? 0,
    steward_count: stewardByNest.get(n.id) ?? 0,
  }));
  return c.json({ nests: withMeta });
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

// POST /nests/import — import a folder the user picked in their browser. The
// browser uploads each file's relative path + content; the server writes them
// into the nest's own storage under DATA_ROOT (it never browses its own disk),
// so import works whether or not the server is colocated with the user.
nestRoutes.post("/import", async (c) => {
  const body = await c.req.json<{
    name?: string;
    files?: { path: string; content: string }[];
  }>();
  if (!body.name) {
    throw new ValidationError("name is required");
  }
  const files = Array.isArray(body.files) ? body.files : [];
  const userId = c.get("userId");
  const nest = await importNest(userId, body.name, files);
  // Seed governance rows for the documents already in the folder so they
  // list as published and edit from their real version (not from scratch).
  const documents = await registerImportedDocuments(
    nest.id,
    await resolveCallerEmail(userId),
  );
  return c.json({ nest, documents }, 201);
});

// GET /nests/unsynced — list folders under DATA_ROOT that are candidates for
// sync (dropped in by the starter CLI or copied in manually). In key mode only
// the license-admin sees them; the listing reflects server-side filesystem
// state, so non-admins shouldn't be probing what's lying around on disk.
// Must be registered before `/:nestId` so the literal segment wins routing.
nestRoutes.get("/unsynced", async (c) => {
  const userId = c.get("userId");
  if (config.AUTH_MODE !== "open" && !(await isLicenseAdminUserId(userId))) {
    throw new ForbiddenError("Only the server admin can list unsynced folders");
  }
  return c.json({ folders: listUnsyncedFolders() });
});

// POST /nests/unsynced/sync — convert a sibling folder into a real nest.
// Folder identifier travels in the body because leaf paths contain slashes
// ("nodes/architecture") that would split a path-param across route segments.
// Same admin-gate as the list endpoint (touches server disk).
nestRoutes.post("/unsynced/sync", async (c) => {
  const userId = c.get("userId");
  if (config.AUTH_MODE !== "open" && !(await isLicenseAdminUserId(userId))) {
    throw new ForbiddenError("Only the server admin can sync folders");
  }
  const body = await c.req.json<{ name?: string }>();
  if (!body?.name) {
    throw new ValidationError("name is required");
  }
  const result = await syncUnsyncedFolder(
    userId,
    body.name,
    await resolveCallerEmail(userId),
  );
  return c.json(result, 201);
});

// GET /nests/:nestId
nestRoutes.get("/:nestId", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const permission = await effectivePermission(nestId, userId);
  if (permission === "none") {
    throw new NotFoundError("Nest not found");
  }

  // Caller's merged effective roles (collaborator + steward), nest-wide. The
  // client gates action buttons off this instead of re-deriving from two
  // lists. Force 'owner' when open-mode/anon promotion granted it but the
  // raw resolver (which is not open-mode-aware) didn't.
  const email = await resolveCallerEmail(userId);
  let roles = await resolveUserRoles(nestId, email);
  if (permission === "owner" && !roles.includes("owner")) {
    roles = ["owner", ...roles];
  }

  // Caller's OWN steward rows (scoped) — the full roster is admin-only, but a
  // reviewer/editor needs their own rows to gate per-node affordances.
  const myStewards = await getStewardsForUser(nestId, email);

  const nest = await getNest(nestId);
  return c.json({ nest, permission, roles, myStewards });
});

// PATCH /nests/:nestId — rename nest (and/or update description). Owner or
// admin (nest-admin role) only; shared collaborators with edit access do not
// get rename rights because the slug is user-visible and changing it ripples
// to URLs/links.
nestRoutes.patch("/:nestId", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const permission = await effectivePermission(nestId, userId);
  if (permission === "none") {
    throw new NotFoundError("Nest not found");
  }
  if (permission !== "owner" && permission !== "admin") {
    throw new ForbiddenError(
      "Only the nest owner or an admin can rename a nest.",
    );
  }
  const body = await c.req.json<{
    name?: string;
    description?: string | null;
  }>();
  const nest = await renameNest(nestId, {
    name: body.name,
    description: body.description,
  });
  return c.json({ nest });
});

// DELETE /nests/:nestId
nestRoutes.delete("/:nestId", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");

  // Real-owner nests are deletable only by that owner. The ungoverned
  // commons (anon-owned nests) are the exception:
  //   - open mode: effectivePermission promotes anon nests to "owner" for
  //     every caller, so anyone in the workspace can delete them.
  //   - key mode (closed/single): the server license-admin acts as
  //     caretaker for the commons; without this branch their real user-id
  //     resolves to "none" and the delete 404s.
  const nest = await getNest(nestId);
  if (!nest) {
    throw new NotFoundError("Nest not found");
  }
  const permission = await effectivePermission(nestId, userId);
  const isAnonOwned = nest.user_id === ANON_USER_ID;
  const adminCaretaker =
    config.AUTH_MODE !== "open" &&
    isAnonOwned &&
    (await isLicenseAdminUserId(userId));
  if (permission !== "owner" && !adminCaretaker) {
    throw new ForbiddenError(
      "You don't have permission to delete this nest. Only the nest owner can delete it.",
    );
  }

  await deleteNest(nestId);
  return c.json({ deleted: true });
});

// GET /nests/:nestId/settings — read nest settings (stewardship enabled, etc.)
nestRoutes.get("/:nestId/settings", async (c) => {
  const nestId = c.req.param("nestId")!;
  const permission = await effectivePermission(nestId, c.get("userId"));
  if (permission === "none") {
    throw new NotFoundError("Nest not found");
  }
  return c.json({
    stewardship_enabled: await isStewardshipEnabled(nestId),
    allow_self_approve: await nestAllowsSelfApprove(nestId),
  });
});

// PATCH /nests/:nestId/settings — update settings (admin-only)
nestRoutes.patch("/:nestId/settings", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");

  // Server admin, nest owner, or an admin collaborator — owners delegate
  // governance (stewards, settings, people) by granting admin; destructive
  // owner-only actions (delete, transfer) stay with the owner.
  const isServerAdmin = await isLicenseAdminUserId(userId);
  const permission = await effectivePermission(nestId, userId);

  if (!isServerAdmin && permission !== "owner" && permission !== "admin") {
    return c.json(
      {
        error:
          "Only a nest admin, the nest owner, or the server license-admin can update nest settings.",
      },
      403,
    );
  }

  const body = await c.req.json<{
    stewardship_enabled?: boolean;
    allow_self_approve?: boolean;
  }>();
  let wiped: {
    stewards: number;
    pendingReviews: number;
  } | null = null;
  if (typeof body.stewardship_enabled === "boolean") {
    if (body.stewardship_enabled) {
      await setStewardshipEnabled(nestId, true);
    } else {
      // Disabling hard-deletes every steward + pending review for the nest
      // (see disableStewardshipAndWipeGovernance) — irreversible. Keep this
      // destructive teardown with the owner/server-admin, alongside the other
      // owner-only actions (delete, transfer). An admin collaborator may
      // toggle the harmless settings below but not wipe governance state.
      if (!isServerAdmin && permission !== "owner") {
        return c.json(
          {
            error:
              "Only the nest owner or the server license-admin can disable stewardship (this permanently wipes stewards and pending reviews).",
          },
          403,
        );
      }
      // Collaborator shares are left intact — sharing is independent of
      // governance.
      wiped = await disableStewardshipAndWipeGovernance(nestId);
    }
  }
  // Self-approve bypass is independent of stewardship — turning it off does not
  // retroactively revoke approvals; it only gates future SoD checks.
  if (typeof body.allow_self_approve === "boolean") {
    await setAllowSelfApprove(nestId, body.allow_self_approve);
  }

  return c.json({
    stewardship_enabled: await isStewardshipEnabled(nestId),
    allow_self_approve: await nestAllowsSelfApprove(nestId),
    wiped,
  });
});
