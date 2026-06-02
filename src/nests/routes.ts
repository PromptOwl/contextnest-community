import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveNestPermission } from "../shared/access.js";
import {
  createNest,
  listNests,
  listSharedNests,
  listPublicNests,
  getNest,
  deleteNest,
  isStewardshipEnabled,
  setStewardshipEnabled,
  disableStewardshipAndWipeGovernance,
  nestAllowsSelfApprove,
  setAllowSelfApprove,
} from "./service.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../shared/errors.js";
import {
  resolveUserRoles,
  getStewardsForUser,
} from "../governance/stewardship-service.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
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
  // Collaborator/steward grants are independent of stewardship — a shared
  // nest stays visible whether or not governed mode is on.
  const shared = listSharedNests(userId);
  // Public-but-not-mine; surfaces them in dashboard list.
  const publicExtras = listPublicNests(userId);

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
  // Resolve the caller's email once so we can merge steward roles into the
  // per-card label. A steward (editor/reviewer) without a collaborator grant
  // resolves to permission='read' (see resolveNestPermission), so the card
  // would mislabel them "Viewer" unless we surface their steward roles too.
  const callerEmail = resolveCallerEmail(userId);
  const annotate = (n: { id: string; user_id: string }) => {
    const permission = effectivePermission(n.id, userId);
    const is_owner = permission === "owner";
    let owner_email: string | null = null;
    // Merged effective roles (collaborator + steward), nest-wide. Only needed
    // for shared cards (owner cards don't show a role badge).
    const roles = is_owner ? ["owner"] : resolveUserRoles(n.id, callerEmail);
    if (!is_owner && n.user_id !== ANON_USER_ID) {
      const row = ownerEmailStmt.get(n.user_id) as
        | { email?: string }
        | undefined;
      owner_email = row?.email ?? null;
    }
    return { ...n, permission, is_owner, owner_email, roles };
  };
  // Dedupe by id; owner/shared rows win over public discovery row.
  const seen = new Set<string>();
  const out: ReturnType<typeof annotate>[] = [];
  for (const n of [...owned, ...shared, ...publicExtras]) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(annotate(n));
  }
  return c.json({ nests: out });
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
  const userId = c.get("userId");
  const permission = effectivePermission(nestId, userId);
  if (permission === "none") {
    throw new NotFoundError("Nest not found");
  }

  // Caller's merged effective roles (collaborator + steward), nest-wide. The
  // client gates action buttons off this instead of re-deriving from two
  // lists. Force 'owner' when open-mode/anon promotion granted it but the
  // raw resolver (which is not open-mode-aware) didn't.
  const email = resolveCallerEmail(userId);
  let roles = resolveUserRoles(nestId, email);
  if (permission === "owner" && !roles.includes("owner")) {
    roles = ["owner", ...roles];
  }

  // Caller's OWN steward rows (scoped) — the full roster is admin-only, but a
  // reviewer/editor needs their own rows to gate per-node affordances.
  const myStewards = getStewardsForUser(nestId, email);

  const nest = getNest(nestId);
  return c.json({ nest, permission, roles, myStewards });
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
  const nest = getNest(nestId);
  if (!nest) {
    throw new NotFoundError("Nest not found");
  }
  const permission = effectivePermission(nestId, userId);
  const isAnonOwned = nest.user_id === ANON_USER_ID;
  const adminCaretaker =
    config.AUTH_MODE !== "open" &&
    isAnonOwned &&
    isLicenseAdminUserId(userId);
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
  const permission = effectivePermission(nestId, c.get("userId"));
  if (permission === "none") {
    throw new NotFoundError("Nest not found");
  }
  return c.json({
    stewardship_enabled: isStewardshipEnabled(nestId),
    allow_self_approve: nestAllowsSelfApprove(nestId),
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
      setStewardshipEnabled(nestId, true);
    } else {
      // Disable tears down governance (stewards + pending reviews) atomically
      // with the flag flip. Collaborator shares are left intact — sharing is
      // independent of governance. See disableStewardshipAndWipeGovernance.
      wiped = disableStewardshipAndWipeGovernance(nestId);
    }
  }
  // Self-approve bypass is independent of stewardship — turning it off does not
  // retroactively revoke approvals; it only gates future SoD checks.
  if (typeof body.allow_self_approve === "boolean") {
    setAllowSelfApprove(nestId, body.allow_self_approve);
  }

  return c.json({
    stewardship_enabled: isStewardshipEnabled(nestId),
    allow_self_approve: nestAllowsSelfApprove(nestId),
    wiped,
  });
});
