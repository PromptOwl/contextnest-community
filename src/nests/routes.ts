import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import {
  resolveNestPermission,
  resolveNestAccess,
  capForArchive,
  isServerAdminUserId,
} from "../shared/access.js";
import {
  createNest,
  importNest,
  listNests,
  listSharedNests,
  listPublicNests,
  getNest,
  deleteNest,
  archiveNest,
  restoreNest,
  pinNest,
  unpinNest,
  pinnedNestIds,
  renameNest,
  isStewardshipEnabled,
  setStewardshipEnabled,
  disableStewardshipAndWipeGovernance,
  nestAllowsSelfApprove,
  setAllowSelfApprove,
  nestReviewsPrimeOnly,
  setPrimeOnlyReview,
  nestPrimeTags,
  setPrimeTags,
} from "./service.js";
import {
  registerImportedDocuments,
  stageImportedFiles,
  isDerivedAnnotationsNode,
  DERIVED_ANNOTATIONS_SUFFIX,
} from "../nodes/service.js";
import {
  listUnsyncedFolders,
  syncUnsyncedFolder,
  deleteUnsyncedFolder,
} from "./unsynced-service.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { grantCoversNode } from "../governance/grants-service.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../shared/errors.js";
import {
  resolveUserRoles,
  getStewardsForUser,
  resolveGrantRoles,
} from "../governance/stewardship-service.js";
import { getDb } from "../db/client.js";
import { suffixOf } from "../db/sql.js";
import { config } from "../config.js";
import { isLicenseAdminUserId } from "../auth/license.js";
import { ANON_USER_ID } from "../shared/constants.js";
import { attributeRequest } from "../shared/client-metadata.js";

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
/**
 * As effectivePermission, but hands back the underlying facts too, so a caller
 * that also needs "is this grant-only?" doesn't re-resolve the whole thing.
 * `access.permission` is the RAW merge — "none" for a grantee — while the
 * returned `permission` is the route-layer view.
 */
async function effectiveAccess(nestId: string, userId: string) {
  // One fetch answers the open-mode commons check, the permission merge, and
  // the grant check below — all three used to be separate round trips.
  const access = await resolveNestAccess(nestId, userId);
  if (config.AUTH_MODE === "open" && access.ownerId === ANON_USER_ID) {
    // The commons promotion is an access rule, not an exemption from archiving
    // — an archived nest is read-only here too. `rawPermission` still says
    // "owner", which is what archive/restore/delete gate on.
    return {
      permission: capForArchive("owner", access.archived),
      access: { ...access, rawPermission: "owner" as const },
    };
  }
  const permission = access.permission;
  // Someone shared a single document or folder holds no nest-wide permission,
  // so resolveNestPermission answers "none" — and it must keep doing so, since
  // app.ts routes exactly that answer into the per-node grant checks. At the
  // route layer, though, "none" means 404, which 404'd the very nest they were
  // just given a link into: the middleware admitted them, then the handlers
  // told them it did not exist.
  //
  // Treat a grantee as a reader HERE, in the one helper every nest route
  // shares, rather than per-handler. It widens nothing that matters: handlers
  // that do real work (rename, delete, import, settings write) demand
  // owner/admin and now answer 403 instead of 404, and every document read
  // still runs through the grants themselves (listNodesForCaller and the
  // middleware), so a grantee sees their slice and no more.
  if (permission === "none" && access.hasGrant) {
    return { permission: "read" as const, access };
  }
  return { permission, access };
}

async function effectivePermission(nestId: string, userId: string) {
  return (await effectiveAccess(nestId, userId)).permission;
}

/** True when the caller reaches this nest ONLY through a share grant. */
function isGrantOnly(access: { permission: string; hasGrant: boolean }) {
  return access.permission === "none" && access.hasGrant;
}

export const nestRoutes = new Hono<AuthEnv>();

// GET /nests[?archived=1]
nestRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  // ?archived=1 is the dashboard's Archived tab: ONLY archived nests, and only
  // owned ones. Archive, restore and delete are the owner's, so a collaborator
  // has nothing to do with an archived nest — shared and public discovery skip
  // archived rows entirely rather than showing cards with no action on them.
  const archivedOnly = c.req.query("archived") === "1";
  const owned = await listNests(userId, { archived: archivedOnly });
  // Collaborator/steward grants are independent of stewardship — a shared
  // nest stays visible whether or not governed mode is on.
  const shared = archivedOnly ? [] : await listSharedNests(userId);
  // Public-but-not-mine; surfaces them in dashboard list.
  const publicExtras = archivedOnly ? [] : await listPublicNests(userId);

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
  // The caller's pins, in one query for the whole grid rather than a boolean
  // lookup per card. Stamped onto every row below so the dashboard can float
  // them to the top without a second round-trip.
  const pinned = await pinnedNestIds(userId);
  // Nests the caller reaches ONLY through a share grant (one document or one
  // folder). resolveNestPermission returns "none" for them by design — a grant
  // is not nest-wide access — so the card is labelled from these rows instead,
  // and its counts/roster are scoped below. One query, not one per card.
  const myGrantRows = (await db.all(
    "SELECT nest_id, target FROM grants WHERE user_id = ?",
    [userId],
  )) as Array<{ nest_id: string; target: string }>;
  const grantTargetsByNest = new Map<string, Array<{ target: string }>>();
  for (const r of myGrantRows) {
    const arr = grantTargetsByNest.get(r.nest_id) ?? [];
    arr.push({ target: r.target });
    grantTargetsByNest.set(r.nest_id, arr);
  }
  const annotate = async (n: { id: string; user_id: string; stewardship_enabled?: number }) => {
    const { permission, access } = await effectiveAccess(n.id, userId);
    // Grant-only card: the caller reaches this nest ONLY through a share
    // grant, so the card describes their slice (counts scoped below, roster
    // withheld). The RAW merge on `access` is what distinguishes them —
    // someone who is both a collaborator and a grantee is a normal reader.
    if (
      permission !== "owner" && // open-mode commons promotion outranks a grant
      isGrantOnly(access)
    ) {
      const owner_email =
        n.user_id === ANON_USER_ID
          ? null
          : ((await db.get(ownerEmailSql, [n.user_id])) as { email?: string } | undefined)
              ?.email ?? null;
      return {
        ...n,
        permission: "read" as const,
        is_owner: false,
        owner_email,
        roles: ["viewer"],
        grant_only: true,
        stewardship_enabled: !!n.stewardship_enabled,
        pinned: pinned.has(n.id),
      };
    }
    // Ownership, not the effective permission: an archived nest caps everyone
    // at 'read', and the card still has to offer its owner Restore and Delete.
    const is_owner = access.rawPermission === "owner";
    const needOwnerEmail = !is_owner && n.user_id !== ANON_USER_ID;
    // Role badge on shared cards. resolveGrantRoles merges the caller's RAW
    // grants (collaborator + steward + team) in parallel — NOT resolveUserRoles,
    // which folds a license/super admin to "admin" on every nest and would
    // mislabel a server admin who is only an editor here. Owner-email lookup is
    // independent, so fire both together.
    const [roles, owner_email] = await Promise.all([
      is_owner
        ? Promise.resolve<string[]>(["owner"])
        : resolveGrantRoles(n.id, callerEmail, userId),
      needOwnerEmail
        ? (db.get(ownerEmailSql, [n.user_id]) as Promise<{ email?: string } | undefined>).then(
            (row) => row?.email ?? null,
          )
        : Promise.resolve<string | null>(null),
    ]);
    // Surface governance state so the dashboard card's "Ungoverned" badge
    // reflects whether stewardship is actually on — not just anon-ownership.
    // The column already rode in on the SELECT * row, so no per-nest query.
    return {
      ...n,
      permission,
      is_owner,
      owner_email,
      roles,
      grant_only: false,
      stewardship_enabled: !!n.stewardship_enabled,
      pinned: pinned.has(n.id),
    };
  };
  // Dedupe by id (owner/shared rows win over public discovery row), then
  // annotate every card concurrently — the per-nest grant lookups are the
  // dashboard's hot path, so a serial loop paid N× the latency for nothing.
  const seen = new Set<string>();
  const deduped: Array<(typeof owned)[number]> = [];
  for (const n of [...owned, ...shared, ...publicExtras]) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    deduped.push(n);
  }
  const out = await Promise.all(deduped.map(annotate));

  // Tile metadata: per-nest document count + people (collaborators + active
  // stewards). All three are single grouped queries rather than per-nest
  // work — the doc count uses node_versions (every live doc, API-created or
  // imported, is registered there; deletes remove its rows) so listing stays
  // one round-trip instead of a filesystem scan per card on every load.
  // NOTE: Postgres returns COUNT(...) as a string (bigint), SQLite as a number.
  // Coerce with Number(r.c) so document_count is a real number — otherwise the
  // dashboard banner's `sum + n.document_count` concatenates ("40"+"0"+"346"…)
  // instead of adding, producing a giant nonsense total.
  // The same grouped scan also yields the newest version timestamp per nest,
  // which is what "recent activity" means for a nest — the nests row itself
  // only carries created_at.
  //
  // The derived `— Annotations` projections are excluded from the COUNT but
  // NOT from the rows: they are machine-maintained nodes that every listing
  // hides (isDerivedAnnotationsNode), so counting them made a card read one
  // document high per commented artifact — permanently, which is what a stale
  // cache looks like. A conditional COUNT rather than a WHERE, because
  // MAX(created_at) comes from the same scan and a comment IS activity on the
  // nest: dropping those rows would make a just-discussed nest look untouched.
  const docRows = (await db.all(
    `SELECT nest_id,
            COUNT(DISTINCT CASE
              WHEN ${suffixOf(db, "node_id", DERIVED_ANNOTATIONS_SUFFIX.length)} <> ?
              THEN node_id END) AS c,
            MAX(created_at) AS last_activity
       FROM node_versions GROUP BY nest_id`,
    [DERIVED_ANNOTATIONS_SUFFIX],
  )) as Array<{ nest_id: string; c: number; last_activity: string | null }>;
  const docByNest = new Map(docRows.map((r) => [r.nest_id, Number(r.c)]));
  const activityByNest = new Map(docRows.map((r) => [r.nest_id, r.last_activity]));
  const collabRows = (await db.all(
    "SELECT nest_id, COUNT(*) AS c FROM nest_collaborators GROUP BY nest_id",
  )) as Array<{ nest_id: string; c: number }>;
  const collabByNest = new Map(collabRows.map((r) => [r.nest_id, Number(r.c)]));
  const stewardRows = (await db.all(
    "SELECT nest_id, COUNT(DISTINCT user_email) AS c FROM stewards WHERE is_active = 1 GROUP BY nest_id",
  )) as Array<{ nest_id: string; c: number }>;
  const stewardByNest = new Map(stewardRows.map((r) => [r.nest_id, Number(r.c)]));
  // Who, not just how many — the card face shows the actual people. Two
  // grouped queries; capped client-side to a handful of chips.
  const stewardEmailRows = (await db.all(
    `SELECT nest_id, user_email FROM stewards WHERE is_active = 1
      GROUP BY nest_id, user_email ORDER BY MIN(assigned_at)`,
  )) as Array<{ nest_id: string; user_email: string }>;
  const stewardEmailsByNest = new Map<string, string[]>();
  for (const r of stewardEmailRows) {
    const arr = stewardEmailsByNest.get(r.nest_id) ?? [];
    if (arr.length < 8) arr.push(r.user_email);
    stewardEmailsByNest.set(r.nest_id, arr);
  }
  const collabEmailRows = (await db.all(
    `SELECT nc.nest_id, u.email FROM nest_collaborators nc
       JOIN users u ON u.id = nc.user_id ORDER BY nc.granted_at`,
  )) as Array<{ nest_id: string; email: string }>;
  const collabEmailsByNest = new Map<string, string[]>();
  for (const r of collabEmailRows) {
    const arr = collabEmailsByNest.get(r.nest_id) ?? [];
    if (arr.length < 8) arr.push(r.email);
    collabEmailsByNest.set(r.nest_id, arr);
  }
  // A grant-only card must describe the caller's slice, not the nest. The
  // grouped counts above are nest-wide totals, and the people rows are the
  // nest's roster — both would tell someone shared one document how many
  // documents and which colleagues they cannot see. Count the node ids their
  // grants actually cover (one query for all such nests) and blank the roster.
  const grantOnlyIds = out.filter((n) => n.grant_only).map((n) => n.id);
  const grantedDocsByNest = new Map<string, number>();
  if (grantOnlyIds.length) {
    const rows = (await db.all(
      `SELECT DISTINCT nest_id, node_id FROM node_versions
        WHERE nest_id IN (${grantOnlyIds.map(() => "?").join(",")})`,
      grantOnlyIds,
    )) as Array<{ nest_id: string; node_id: string }>;
    for (const r of rows) {
      const targets = grantTargetsByNest.get(r.nest_id) ?? [];
      if (isDerivedAnnotationsNode(r.node_id)) continue;
      if (grantCoversNode(targets, r.node_id)) {
        grantedDocsByNest.set(r.nest_id, (grantedDocsByNest.get(r.nest_id) ?? 0) + 1);
      }
    }
  }
  const withMeta = out.map((n) =>
    n.grant_only
      ? {
          ...n,
          document_count: grantedDocsByNest.get(n.id) ?? 0,
          collaborator_count: 0,
          steward_count: 0,
          steward_emails: [] as string[],
          collaborator_emails: [] as string[],
        }
      : {
          ...n,
          last_activity: activityByNest.get(n.id) ?? null,
          document_count: docByNest.get(n.id) ?? 0,
          collaborator_count: collabByNest.get(n.id) ?? 0,
          steward_count: stewardByNest.get(n.id) ?? 0,
          steward_emails: stewardEmailsByNest.get(n.id) ?? [],
          collaborator_emails: collabEmailsByNest.get(n.id) ?? [],
        },
  );
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
// Registered as /:nestId with a literal-"import" branch (see the router-compat
// note on the unsynced routes below): a static /import sibling would knock the
// app off RegExpRouter. There is no other POST /nests/:nestId endpoint.
//
// Three call shapes, all ordinary JSON (there is deliberately no streaming
// variant any more — NDJSON progress had already committed a 200 before the
// work ran, so every real failure reached the UI as a bare "Import failed",
// and a buffering proxy swallowed the progress lines it existed to deliver):
//   { name, files, partial: true } → create the nest, write the first chunk
//   { nestId, files }              → write another chunk into that nest
//   { nestId, finalize: true }     → register the documents, return the count
// `{ name, files }` with no flags stays the one-shot import (tests, CLI).
nestRoutes.post("/:nestId", async (c) => {
  if (c.req.param("nestId") !== "import") {
    throw new NotFoundError("Not found");
  }
  const body = await c.req.json<{
    name?: string;
    files?: { path: string; content: string }[];
    nestId?: string;
    partial?: boolean;
    finalize?: boolean;
  }>();
  const files = Array.isArray(body.files) ? body.files : [];
  const userId = c.get("userId");

  // Continuation of a chunked upload. Owner-only: these calls write files
  // straight into a nest's storage, so anything less would let any caller
  // inject documents into someone else's nest.
  if (body.nestId) {
    const target = body.nestId;
    const nest = await getNest(target);
    if (
      !nest ||
      !nest.is_imported ||
      (await effectivePermission(target, userId)) !== "owner"
    ) {
      throw new NotFoundError("Nest not found");
    }
    const email = await resolveCallerEmail(userId);
    if (body.finalize) {
      return c.json({
        nest,
        documents: await registerImportedDocuments(
          target,
          email,
          attributeRequest(c, (body as { client?: unknown }).client),
        ),
      });
    }
    // Staging writes files straight into vault storage, skipping the node
    // creation path and its title/id validation and write locks. That is the
    // point during an upload — the files carry their own paths and frontmatter
    // — but it should not stay open afterwards as a general raw-write door into
    // any nest the caller happens to own. Finalizing registers the documents,
    // so "nothing registered yet" is the upload still being in flight.
    const registered = (await getDb().get(
      "SELECT COUNT(*) AS c FROM node_versions WHERE nest_id = ?",
      [target],
    )) as { c: number } | undefined;
    if (Number(registered?.c ?? 0) > 0) {
      throw new ValidationError(
        "This nest has already been imported. Start a new import instead of adding files to a finished one.",
      );
    }
    console.log(`[import] chunk: nest=${target} files=${files.length}`);
    // `rejected` travels back so the browser can tell the user which files were
    // skipped, rather than reporting a clean import that quietly dropped some.
    return c.json(await stageImportedFiles(target, files, email));
  }

  if (!body.name) {
    throw new ValidationError("name is required");
  }
  console.log(
    `[import] request: name=${JSON.stringify(body.name)} files=${files.length}` +
      (body.partial ? " (first chunk)" : ""),
  );
  const email = await resolveCallerEmail(userId);
  const nest = await importNest(userId, body.name);
  try {
    const { rejected } = await stageImportedFiles(nest.id, files, email);
    // More chunks are coming — registering now would publish a partial folder.
    if (body.partial) {
      return c.json({ nest, rejected }, 201);
    }
    // Seed governance rows for the documents already in the folder so they
    // list as published and edit from their real version (not from scratch).
    const documents = await registerImportedDocuments(
      nest.id,
      email,
      attributeRequest(c, (body as { client?: unknown }).client),
    );
    return c.json({ nest, documents, rejected }, 201);
  } catch (err) {
    // The nest row exists before its content does, so a failed first chunk
    // would otherwise leave an empty nest on the dashboard.
    await deleteNest(nest.id).catch(() => {});
    throw err;
  }
});

// GET /nests/unsynced — list folders under DATA_ROOT that are candidates for
// sync (dropped in by the starter CLI or copied in manually). In key mode only
// a server admin (license admin or superadmin — same resolution as /admin/*)
// sees them; the listing reflects server-side filesystem state, so non-admins
// shouldn't be probing what's lying around on disk.
//
// Served from inside the `/:nestId` param route (literal "unsynced" branch),
// NOT as a static sibling route: RegExpRouter refuses a static path beside a
// param at the same position (UnsupportedPathError), which silently dropped
// the WHOLE app onto TrieRouter — and TrieRouter can't match greedy suffix
// routes like /:nodeId{.+}/versions for ids nested 3+ segments deep. The
// public URLs are unchanged.
async function handleUnsyncedList(c: any) {
  const userId = c.get("userId");
  if (config.AUTH_MODE !== "open" && !(await isServerAdminUserId(userId))) {
    throw new ForbiddenError("Only the server admin can list unsynced folders");
  }
  return c.json({ folders: listUnsyncedFolders() });
}

// POST /nests/unsynced/sync — convert a sibling folder into a real nest.
// Folder identifier travels in the body because leaf paths contain slashes
// ("nodes/architecture") that would split a path-param across route segments.
// Same admin-gate as the list endpoint (touches server disk). Registered as
// /:nestId/sync for the router-compat reason above; only the literal
// "unsynced" segment is served, anything else 404s.
nestRoutes.post("/:nestId/sync", async (c) => {
  if (c.req.param("nestId") !== "unsynced") {
    throw new NotFoundError("Not found");
  }
  const userId = c.get("userId");
  if (config.AUTH_MODE !== "open" && !(await isServerAdminUserId(userId))) {
    throw new ForbiddenError("Only the server admin can sync folders");
  }
  const body = await c.req.json<{ name?: string; client?: unknown }>();
  if (!body?.name) {
    throw new ValidationError("name is required");
  }
  const result = await syncUnsyncedFolder(
    userId,
    body.name,
    await resolveCallerEmail(userId),
    attributeRequest(c, body.client),
  );
  return c.json(result, 201);
});

// DELETE /nests/unsynced/sync — remove an unsynced folder the user doesn't want
// (leftover files taking up space, no intention to sync). Same admin-gate as
// sync (touches server disk). Name travels in the body because leaf paths
// contain slashes. Registered on the same literal "unsynced" branch.
nestRoutes.delete("/:nestId/sync", async (c) => {
  if (c.req.param("nestId") !== "unsynced") {
    throw new NotFoundError("Not found");
  }
  const userId = c.get("userId");
  if (config.AUTH_MODE !== "open" && !(await isServerAdminUserId(userId))) {
    throw new ForbiddenError("Only the server admin can delete folders");
  }
  const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
  if (!body?.name) {
    throw new ValidationError("name is required");
  }
  await deleteUnsyncedFolder(body.name);
  return c.json({ ok: true });
});

// GET /nests/:nestId
nestRoutes.get("/:nestId", async (c) => {
  const nestId = c.req.param("nestId")!;
  if (nestId === "unsynced") return handleUnsyncedList(c);
  const userId = c.get("userId");
  const { permission, access } = await effectiveAccess(nestId, userId);
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

  // A reader with no role at all is either a public reader or a share
  // grantee. Label the grantee so the client can present a shared slice
  // (viewer badge, no nest-wide affordances) instead of a bare nest.
  const grant_only = roles.length === 0 && isGrantOnly(access);

  const nest = await getNest(nestId);
  return c.json({
    nest,
    permission,
    roles: grant_only ? ["viewer"] : roles,
    myStewards,
    grant_only,
  });
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


/**
 * POST/DELETE /nests/:nestId/pin — the caller's own bookmark on this nest.
 *
 * No permission tier beyond seeing the nest: a pin changes nothing about the
 * nest and is visible to nobody else, so a viewer may pin exactly as an owner
 * does. It is NOT ungated, though — the read check below is what stops the
 * endpoint being used to find out whether a nest id exists.
 */
nestRoutes.post("/:nestId/pin", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  if ((await effectivePermission(nestId, userId)) === "none") {
    throw new NotFoundError("Nest not found");
  }
  await pinNest(userId, nestId);
  return c.json({ pinned: true });
});

nestRoutes.delete("/:nestId/pin", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  if ((await effectivePermission(nestId, userId)) === "none") {
    throw new NotFoundError("Nest not found");
  }
  await unpinNest(userId, nestId);
  return c.json({ pinned: false });
});

/**
 * The gate for the three whole-nest actions: delete, archive, restore. Real-owner
 * nests are the owner's alone. The ungoverned commons (anon-owned nests) are the
 * exception:
 *   - open mode: effectiveAccess promotes anon nests to "owner" for every
 *     caller, so anyone in the workspace can act on them.
 *   - key mode (closed/single): the server license-admin acts as caretaker for
 *     the commons; without this branch their real user-id resolves to "none"
 *     and the call 404s.
 *
 * Gates on `rawPermission`, not the effective one: an archived nest caps
 * everybody at 'read', and restoring or deleting it has to stay possible.
 */
async function requireNestCaretaker(nestId: string, userId: string, verb: string) {
  const nest = await getNest(nestId);
  if (!nest) {
    throw new NotFoundError("Nest not found");
  }
  const { access } = await effectiveAccess(nestId, userId);
  const adminCaretaker =
    config.AUTH_MODE !== "open" &&
    nest.user_id === ANON_USER_ID &&
    (await isLicenseAdminUserId(userId));
  if (access.rawPermission !== "owner" && !adminCaretaker) {
    throw new ForbiddenError(
      `You don't have permission to ${verb} this nest. Only the nest owner can ${verb} it.`,
    );
  }
  return nest;
}

// DELETE /nests/:nestId
nestRoutes.delete("/:nestId", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireNestCaretaker(nestId, c.get("userId"), "delete");
  await deleteNest(nestId);
  return c.json({ deleted: true });
});

// POST /nests/:nestId/archive — put the nest away, reversibly. Nothing is
// deleted: it leaves every listing, goes read-only (see resolveNestAccess) and
// its published links stop resolving until it is restored.
nestRoutes.post("/:nestId/archive", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireNestCaretaker(nestId, c.get("userId"), "archive");
  await archiveNest(nestId);
  return c.json({ archived: true });
});

// POST /nests/:nestId/restore — bring it back exactly as it was.
nestRoutes.post("/:nestId/restore", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireNestCaretaker(nestId, c.get("userId"), "restore");
  await restoreNest(nestId);
  return c.json({ restored: true });
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
    prime_only_review: await nestReviewsPrimeOnly(nestId),
    prime_tags: await nestPrimeTags(nestId),
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
    prime_only_review?: boolean;
    prime_tags?: string[] | string;
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
  // Prime settings are non-destructive: flipping them changes which FUTURE
  // writes need review, never the approval state of anything already published.
  if (typeof body.prime_only_review === "boolean") {
    await setPrimeOnlyReview(nestId, body.prime_only_review);
  }
  if (body.prime_tags !== undefined) {
    await setPrimeTags(
      nestId,
      Array.isArray(body.prime_tags) ? body.prime_tags : [body.prime_tags],
    );
  }

  return c.json({
    stewardship_enabled: await isStewardshipEnabled(nestId),
    allow_self_approve: await nestAllowsSelfApprove(nestId),
    prime_only_review: await nestReviewsPrimeOnly(nestId),
    prime_tags: await nestPrimeTags(nestId),
    wiped,
  });
});
