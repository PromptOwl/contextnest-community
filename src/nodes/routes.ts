import { recordNodeAccess } from "../governance/access-log.js";
import { parseTaskFieldsFilter, taskFieldsFromInput } from "./task-fields.js";
import { Hono } from "hono";
import { parseDocument } from "@promptowl/contextnest-engine";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "./engine.js";
import { bulkUpdateNodes } from "./bulk-update.js";
import { bulkMoveNodes, bulkDeleteNodes } from "./bulk-actions.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
// SECURITY: `:nodeId` params on these routes become filesystem paths in the
// engine's storage layer (join(nestRoot, id + ".md"), no containment). A `../`
// id is rejected up front by the assertSafeNodeId chokepoint mounted on
// /nests/:nestId/nodes/:nodeId{.+} in app.ts — covers every node route across
// this + the annotations + governance routers, so handlers here can trust nodeId.
import { attributeRequest, readClient } from "../shared/client-metadata.js";
import { trackEvent } from "../telemetry/tracker.js";
import { getDb } from "../db/client.js";
import * as versions from "../governance/version-service.js";
import { reconstructApproved } from "../governance/approved-body.js";
import * as stewardship from "../governance/stewardship-service.js";
import * as reviews from "../governance/review-service.js";
import {
  resolveCallerEmail,
  canReadNode,
} from "../governance/access-guard.js";
import { isPublicReader } from "../shared/access.js";
import { requestBaseUrl } from "../shared/base-url.js";
import {
  assertContributorCreate,
  assertContributorPatch,
  assertNotPushGated,
  contributeDocument,
  proposeEdit,
} from "../governance/org-contribution.js";
import {
  holdWriteIfGated,
  heldWriteResponse,
} from "../nests/push-confirmation-service.js";
import { resolveNodeGrant } from "../governance/grants-service.js";
import { applyArtifactSandboxHeaders } from "../shared/artifact-sandbox.js";
import {
  nodeToMarkdown,
  isMarkdownFormat,
  isRawFormat,
  rawContentType,
  frontmatterBlockOf,
} from "./markdown-export.js";
import {
  scanDocumentForDrift,
  getPendingChange,
  loadLatestApprovedNode,
} from "../governance/external-edit-service.js";
import {
  listWatchers,
  addWatcher,
  removeWatcher,
} from "../governance/notify-service.js";
import {
  createNode,
  updateNode,
  moveNode,
  deleteNode,
  discardDraft,
  restoreVersion,
  listNodesForCaller,
  nestCensus,
  getNodeForCaller,
  resolveAuthorship,
  toNodeResponse,
  bodyOnly,
  withComputedFields,
  fieldsOfRaw,
  setStoredFields,
} from "./service.js";
import {
  addRelation,
  listRelations,
  openBlockerCounts,
  removeRelation,
} from "./relations.js";

/** Custom field values off a body: absent stays absent; anything that isn't
 *  an object is refused here rather than half-applied. Values themselves are
 *  validated against the nest's definitions in the service. */
function customFieldsFromBody(body: Record<string, unknown>): { fields?: Record<string, unknown> } {
  const v = body.fields;
  if (v === undefined) return {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ValidationError("fields must be an object of field key → value");
  }
  return { fields: v as Record<string, unknown> };
}

/** `?field.<key>=<value>` query params → the list's field filters. */
function fieldFiltersFromQuery(q: Record<string, string>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (k.startsWith("field.") && k.length > "field.".length) out[k.slice("field.".length)] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const nodeRoutes = new Hono<AuthEnv>();

// LLM-pointed plain-text view: GET a node with ?format=markdown to receive
// `text/markdown` (YAML frontmatter + body) instead of JSON, so an agent can
// fetch a stable, human-readable representation. Built from the fully-resolved
// node response so it inherits the same permission + public-reader handling.
function nodeAsMarkdown(response: any, nodeId: string): string {
  return nodeToMarkdown({
    id: nodeId,
    title: response.title,
    tags: response.tags,
    status: response.status,
    body: response.content,
  });
}

// Direct raw fetch (`?format=raw`, or `Accept: text/markdown` with no format
// param): the node BODY as text — no JSON envelope, no synthesized
// frontmatter. Content-Type is per node type (see rawContentType). With
// `?frontmatter=1` the stored YAML frontmatter block is prepended verbatim.
// Built from the same fully-resolved response object the JSON path returns,
// AFTER the access guard and the public-reader downgrade, so it can never
// serve bytes the JSON GET wouldn't — a 403/404 is decided before this runs.
function rawNodeBody(c: any, response: any, storedRaw: string | undefined) {
  const body: string = response.content ?? "";
  const payload =
    c.req.query("frontmatter") === "1"
      ? frontmatterBlockOf(storedRaw) + body
      : body;
  // Raw bytes on the app origin — never let the browser sniff them into
  // something more executable than the declared type.
  c.header("X-Content-Type-Options", "nosniff");
  // Artifact bodies are editor-controlled HTML+JS served as text/html here.
  // Without a sandbox their same-origin scripts would ride the viewer's
  // session. Apply the SAME strict sandbox the /hosted viewer uses (shared
  // helper — see src/shared/artifact-sandbox.ts) so the document runs on an
  // opaque origin with no network reach.
  if ((response.type || "document") === "artifact") {
    applyArtifactSandboxHeaders(c);
  }
  return c.body(payload, 200, {
    "Content-Type": rawContentType(response.type),
  });
}

// GET /nests/:nestId/nodes?type=&tag=&status=&limit=
//
// The filters the service and the MCP tool have always supported were simply
// never wired up here, so REST callers fetched the whole nest and filtered
// client-side — paying the per-node governance enrichment for every document
// they then threw away. `limit` in particular now cuts that work server-side.
nodeRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const q = c.req.query();
  const limit = q.limit ? parseInt(q.limit, 10) : undefined;
  const nodes = await listNodesForCaller(nestId, userId, {
    ...(q.type ? { type: q.type } : {}),
    ...(q.tag ? { tag: q.tag } : {}),
    ...(q.status ? { status: q.status } : {}),
    // Lets an owner preview what making the nest public would expose.
    ...(q.approved_only === "1" || q.approved_only === "true"
      ? { approvedOnly: true }
      : {}),
    // Ignore junk rather than 400 — a bad ?limit should not fail a listing.
    ...(limit !== undefined && Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    // Present (even as "") = one folder level only, for the lazily-expanded
    // document tree. Absent = the whole nest, as every existing caller expects.
    ...(q.folder !== undefined ? { folder: q.folder } : {}),
    // Bodies are off by default — the list is served from the DB index, which
    // holds metadata only. Opt back in and the listing crawls the vault for
    // them; kept for any client that was reading `content` off this route.
    ...(q.content === "1" || q.content === "true" ? { withContent: true } : {}),
    // Board-field filters — same parser MCP's context_list uses.
    task: parseTaskFieldsFilter({
      assignee: q.assignee,
      priority: q.priority,
      due_before: q.due_before,
    }),
    // Custom fields: ?field.<key>=<value>, every one must match.
    ...(fieldFiltersFromQuery(q) ? { fields: fieldFiltersFromQuery(q) } : {}),
  });
  // The nest-wide shape is NOT bundled here: it describes the whole nest
  // whatever level was asked for, so bundling recomputed it on every folder
  // expand. It has its own endpoint and its own cache entry.
  return c.json({ count: nodes.length, nodes });
});

// POST /nests/:nestId/nodes/bulk-update — one patch over many nodes (the
// board List view's bulk actions; MCP context_bulk_update). Write-tier at the
// nest middleware like every POST; each node is then permission-checked and
// governed on its own (src/nodes/bulk-update.ts). Registered before the
// /:nodeId{.+} routes so "bulk-update" is never read as a node id.
nodeRoutes.post("/bulk-update", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const result = await bulkUpdateNodes(
    c.req.param("nestId")!,
    { userId: c.get("userId"), userEmail: await getUserEmail(c) },
    { ids: body.ids, selector: body.selector, patch: body.patch },
    { client: attributeRequest(c, body.client), allowDraft: body.allow_draft === true },
  );
  return c.json(result);
});

// POST /nests/:nestId/nodes/bulk-move { ids, folder } and /bulk-delete { ids } —
// the Documents list's multi-select actions (MCP context_move / context_delete
// with `ids`). Each document is moved or deleted on its own, with the same
// permission and review rules as one by one (src/nodes/bulk-actions.ts).
nodeRoutes.post("/bulk-move", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  return c.json(
    await bulkMoveNodes(
      c.req.param("nestId")!,
      { userId: c.get("userId"), userEmail: await getUserEmail(c) },
      { ids: body.ids, folder: body.folder },
    ),
  );
});

nodeRoutes.post("/bulk-delete", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  return c.json(
    await bulkDeleteNodes(
      c.req.param("nestId")!,
      { userId: c.get("userId"), userEmail: await getUserEmail(c) },
      { ids: body.ids },
      { client: attributeRequest(c, body.client) },
    ),
  );
});

// POST /nests/:nestId/nodes
nodeRoutes.post("/", async (c) => {
  const body = await c.req.json<{
    title?: string;
    content?: string;
    type?: string;
    tags?: string[];
    scope?: string;
    status?: string;
    schedule?: string;
    model?: string;
    folder?: string;
    prime?: boolean;
    client?: unknown;
    assignee?: string | null;
    due?: string | null;
    priority?: string | null;
    parent?: string | null;
    fields?: Record<string, unknown>;
  }>();

  if (!body.title || !body.content) {
    throw new ValidationError("title and content are required");
  }
  if (body.folder !== undefined && typeof body.folder !== "string") {
    throw new ValidationError("folder must be a string path like \"gtm/deals\"");
  }

  const nestId = c.req.param("nestId")!;
  const authorEmail = await getUserEmail(c);

  // Org contributor (CU-wdqcq05rz6): admitted at read tier by the access gate
  // for exactly this route. Their document is a draft sent to review, never
  // published, whatever the nest's self-publish postures.
  if (c.get("orgContribution") === true && c.get("nestPermission") === "read") {
    assertContributorCreate(body as Record<string, unknown>);
    await assertNotPushGated({
      nestId,
      userId: c.get("userId"),
      keyId: c.get("apiKeyId") ?? null,
      agentSurface: false,
    });
    const { node, review } = await contributeDocument(
      nestId,
      {
        title: body.title,
        content: body.content,
        tags: body.tags,
        folder: body.folder,
        client: attributeRequest(c, body.client),
      },
      authorEmail,
      { baseUrl: requestBaseUrl(c.req.url) },
    );
    return c.json(
      {
        node: (await withComputedFields(nestId, [toNodeResponse(node)]))[0],
        review,
        org_contribution: true,
      },
      201,
    );
  }

  // Agent-write gate. Only an API-key caller is held: a person creating a
  // document in the web UI authenticates with a session cookie and is exactly
  // who would be confirming it. Same hold, same 202 contract as bulk publish.
  const keyId = c.get("apiKeyId") ?? null;
  if (keyId) {
    const pending = await holdWriteIfGated({
      nestId,
      userId: c.get("userId"),
      keyId,
      keyLabel: c.get("apiKeyLabel") ?? null,
      userEmail: authorEmail,
      payload: {
        documents: [
          {
            title: body.title,
            content: body.content,
            type: body.type,
            tags: body.tags,
            scope: body.scope,
            status: body.status,
            schedule: body.schedule,
            model: body.model,
            folder: body.folder,
            prime: body.prime,
            ...customFieldsFromBody(body),
          },
        ],
      },
    });
    if (pending) return c.json(heldWriteResponse(nestId, pending), 202);
  }

  const { node } = await createNode(
    nestId,
    {
      title: body.title,
      content: body.content,
      type: body.type,
      tags: body.tags,
      scope: body.scope,
      status: body.status,
      schedule: body.schedule,
      model: body.model,
      folder: body.folder,
      prime: body.prime,
      client: attributeRequest(c, body.client),
      ...taskFieldsFromInput(body),
      ...customFieldsFromBody(body),
    },
    authorEmail,
  );

  // Resolve stewards for the response
  const resolved = await stewardship.resolveStewardsForNode(nestId, node.id);

  return c.json({
    node: (await withComputedFields(nestId, [toNodeResponse(node)]))[0],
    stewards: resolved.length > 0
      ? resolved.map((r) => ({
        email: r.steward.userEmail,
        role: r.steward.role,
        source: r.source,
      }))
      : undefined,
  }, 201);
});

// ─── Governance GET endpoints (before the catch-all) ────────────────
// These must be registered BEFORE the /:nodeId{.+} catch-all.
// Import governance services inline to avoid circular deps.

// NOTE: no `/:nodeId{.+}/stewards` handler here, for the same reason as
// /versions below: governanceNodeRoutes serves that path first. The copy that
// used to sit here was unreachable and ungated — a second, looser door onto
// the same data if the mount order ever changed. The gated one lives there.

// NOTE: no `/:nodeId{.+}/versions` handler here. governanceNodeRoutes is
// mounted ahead of nodeRoutes (see app.ts) and registers the same path, so a
// duplicate here is unreachable — it silently shadowed itself, which is why the
// `resolvedBy` enrichment it used to carry never reached the UI. That query now
// lives in the governance handler alongside the per-version change log.

// GET /nests/:nestId/nodes/:nodeId/reviews
nodeRoutes.get("/:nodeId{.+}/reviews", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  const { getReviewHistory } = await import("../governance/review-service.js");
  const history = await getReviewHistory(nestId, nodeId);
  return c.json({ reviews: history });
});

// POST /nests/:nestId/nodes/:nodeId/discard — throw away the unreviewed work on
// a node: the file goes back to its last sealed version and the draft rows above
// it are dropped. A node that was never published is deleted outright (nothing
// to fall back to) — the response says which happened. POST suffix route.
nodeRoutes.post("/:nodeId{.+}/discard", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) {
    return c.json(
      { error: "Access denied — no steward assignment for this node" },
      403,
    );
  }

  const result = await discardDraft(nestId, nodeId, userEmail);
  return c.json({ ok: true, ...result });
});

// GET /nests/:nestId/nodes/:nodeId{.+} — read a single node (catch-all, must be LAST)
// POST /nests/:nestId/nodes/:nodeId/revert — restore an old version by writing
// its reconstructed content as a NEW version (history is append-only; nothing
// is lost). Read-gated; updateNode applies the write. POST suffix route — no
// POST catch-all to swallow it.
nodeRoutes.post("/:nodeId{.+}/revert", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) {
    return c.json(
      { error: "Access denied — no steward assignment for this node" },
      403,
    );
  }

  const body = await c.req
    .json<{ targetVersion?: number; client?: unknown }>()
    .catch(() => ({}) as { targetVersion?: number; client?: unknown });
  const targetVersion = Number(body.targetVersion);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new ValidationError("targetVersion (a positive integer) is required");
  }

  const { node, version } = await restoreVersion(nestId, nodeId, targetVersion, userEmail, {
    client: attributeRequest(c, body.client),
  });
  await trackEvent("node.revert", { nestId, nodeId, targetVersion });
  return c.json({ ok: true, version, node: toNodeResponse(node) });
});

// POST /nests/:nestId/nodes/:nodeId/move — relocate a document to another
// folder. Body: { "folder": "gtm/deals" } ("" = nest root). The id changes;
// version history, review state, annotations, edges, grants, and traces all
// follow (see moveNode). POST suffix route, same shape as /revert.
nodeRoutes.post("/:nodeId{.+}/move", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) {
    return c.json(
      { error: "Access denied — no steward assignment for this node" },
      403,
    );
  }

  const body = await c.req
    .json<{ folder?: string }>()
    .catch(() => ({}) as { folder?: string });
  if (typeof body.folder !== "string") {
    throw new ValidationError('folder (a string; "" for the nest root) is required');
  }

  const { node, previousId } = await moveNode(nestId, nodeId, body.folder, userEmail);
  return c.json({ ok: true, node: toNodeResponse(node), previousId });
});

// Watchers — "tag a person to this node". Watchers of an agent hear when its
// output lands for review; watchers of a document hear when the document
// itself does. Suffix routes, same shape as /revert and /move.

// GET /nests/:nestId/nodes/:nodeId/watchers
nodeRoutes.get("/:nodeId{.+}/watchers", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  return c.json({ watchers: await listWatchers(nestId, nodeId) });
});

// POST /nests/:nestId/nodes/:nodeId/watchers { email }
nodeRoutes.post("/:nodeId{.+}/watchers", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !email.includes("@")) {
    throw new ValidationError("email is required");
  }
  await addWatcher(nestId, nodeId, email, await getUserEmail(c));
  return c.json({ watchers: await listWatchers(nestId, nodeId) }, 201);
});

// DELETE /nests/:nestId/nodes/:nodeId/watchers?email=
nodeRoutes.delete("/:nodeId{.+}/watchers", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const email = c.req.query("email")?.trim() ?? "";
  if (!email) throw new ValidationError("email query param is required");
  if (!(await removeWatcher(nestId, nodeId, email))) {
    throw new NotFoundError("Not watching");
  }
  return c.json({ watchers: await listWatchers(nestId, nodeId) });
});

// Relations — blocks / blocked_by / relates_to / duplicates (src/nodes/
// relations.ts). Not behind FEATURE_WORKFLOW_PLANE: relations are core task
// UX. Reads are read-tier; POST/DELETE are write-tier via the nest
// middleware, the same tier as editing the task.

// GET /nests/:nestId/nodes/:nodeId/relations
nodeRoutes.get("/:nodeId{.+}/relations", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const caller = { nestId, userId, userEmail: await resolveCallerEmail(userId) };
  return c.json(await listRelations(caller, c.req.param("nodeId")!));
});

// POST /nests/:nestId/nodes/:nodeId/relations { type, node }
nodeRoutes.post("/:nodeId{.+}/relations", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const body = await c.req
    .json<Record<string, unknown>>()
    .catch(() => ({}) as Record<string, unknown>);
  const caller = { nestId, userId, userEmail: await resolveCallerEmail(userId) };
  const out = await addRelation(caller, c.req.param("nodeId")!, body.type, body.node);
  return c.json(out, 201);
});

// DELETE /nests/:nestId/nodes/:nodeId/relations/:relationId
nodeRoutes.delete("/:nodeId{.+}/relations/:relationId", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const caller = { nestId, userId, userEmail: await resolveCallerEmail(userId) };
  return c.json(
    await removeRelation(caller, c.req.param("nodeId")!, c.req.param("relationId")),
  );
});

// GET /nests/:nestId/nodes/:nodeId — the greedy catch-all. Safe ONLY because
// createApp pins LinearRouter: it matches in registration order with
// per-route backtracking, so the suffix action routes above (and the
// governance/annotation sub-routers mounted before this one) win first at
// any id depth. Under the default SmartRouter this same pattern either
// shadows every suffix route (RegExpRouter) or breaks for ids nested 3+
// segments (TrieRouter fallback) — don't change the router without
// re-running test/nested-node-actions.test.ts.
nodeRoutes.get("/:nodeId{.+}", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const { storage, versions: versionManager } = await engineCache.get(nestId);

  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  // Shared read: resolves, gates, and asks the engine to verify the checksum so
  // drift surfaces as pendingChange (last-approved content returned in place of
  // the live bytes, hootie-inbox-spec §4.2). Staging the drift as a suggestion
  // stays here — it is what makes the next pendingChange lookup resolve a real
  // id, and only this surface does it.
  let node = await getNodeForCaller(
    nestId,
    { id: nodeId },
    userId,
    userEmail,
    { verifyChecksum: true },
  );
  if (node.pendingChange) {
    try {
      await scanDocumentForDrift(nestId, nodeId, userEmail || "system:read");
      const refreshed = await getPendingChange(nestId, nodeId);
      if (refreshed) node.pendingChange = refreshed;
    } catch (err) {
      console.error("[external-edit] stage-on-read failed:", err);
    }
    // Engine returns the nearest *keyframe* body (every 10 versions) as
    // the approved baseline — at v=5 that's the v=1 keyframe, so the
    // editor would render the original draft body underneath the drift
    // banner. Reconstruct the actual latest version from history.yaml
    // so the user sees the current approved state, with the drift shown
    // separately via the suggestion patch.
    try {
      const latest = await loadLatestApprovedNode(nestId, nodeId);
      if (latest) {
        node = { ...latest, pendingChange: node.pendingChange };
      }
    } catch (err) {
      console.error("[external-edit] reconstruct-latest failed:", err);
    }
  }
  const [response] = await withComputedFields(nestId, [toNodeResponse(node)]);
  // Open blockers (task relations) — the "Blocked" badge's source.
  const blockers = (await openBlockerCounts(nestId, [node.id])).get(node.id);
  if (blockers) response.open_blockers = blockers;
  // The read got past every gate — record it for the admin activity log
  // (fire-and-forget, throttled; never slows or fails the read).
  recordNodeAccess({
    nestId,
    nodeIds: [node.id],
    action: "read",
    surface: "api",
    userId,
    userEmail,
    client: readClient(c),
    // The version in the response is the one served (the live draft, or the
    // reconstructed latest approved version when there is pending drift).
    versions: { [node.id]: response.version },
  });
  const publicReader = await isPublicReader(nestId, userId);

  // Author + collaborators (same additive fields as the list response).
  // Single-node call takes resolveAuthorship's indexed fast path.
  // Withheld from public readers: the roster is the nest's people, not its
  // published content, so it stays behind the same gate as the body. They
  // keep the frontmatter-only `author` toNodeResponse already set.
  if (!publicReader) {
    const people = (
      await resolveAuthorship(nestId, [
        { id: nodeId, frontmatterAuthor: node.frontmatter?.author ?? null },
      ])
    ).get(nodeId);
    if (people) {
      response.author = people.author;
      response.collaborators = people.collaborators;
    }
  }

  // The caller's share grant on THIS node, if any. A grant is access, not
  // stewardship, so it appears in neither the nest permission (a grantee reads
  // as "read" whatever their grant says) nor the per-node steward roles — and
  // without it the client cannot tell a write grantee from a viewer, and shows
  // the person who was granted edit rights a read-only document.
  (response as any).myGrant = await resolveNodeGrant(nestId, userId, nodeId);

  // Public readers see approved version body only. ?approved_only=1 asks for
  // the same body on purpose — an owner previewing the public reader — and
  // mirrors the listing's flag; it narrows what is served, never widens it.
  const approvedOnly = c.req.query("approved_only") === "1" || c.req.query("approved_only") === "true";
  if (publicReader || approvedOnly) {
    let approved = await versions.getApprovedVersion(nestId, nodeId);
    if (approved != null) {
      // Kept for the raw path: frontmatter=1 must serve the APPROVED
      // snapshot's stored frontmatter, never the live working copy's.
      let approvedRaw = "";
      // Field values are the approved version's too, never the live draft's.
      setStoredFields(response, {});
      try {
        ({ raw: approvedRaw, version: approved } = await reconstructApproved(
          versionManager,
          nestId,
          nodeId,
          approved,
        ));
        response.content = bodyOnly(nodeId, approvedRaw);
        setStoredFields(response, fieldsOfRaw(nodeId, approvedRaw));
        await withComputedFields(nestId, [response]);
        // A pdf node's `pdf:` block must describe the same version as the
        // body — the approved one, whose binary is what /pdf serves here —
        // not the live draft's.
        if (response.type === "pdf") {
          const approvedPdf = pdfMetaOf(nodeId, approvedRaw);
          if (approvedPdf) response.pdf = approvedPdf;
        }
      } catch (err) {
        console.error(
          "reconstructVersion failed (public single)",
          nodeId,
          approved,
          err,
        );
        response.content = "";
      }
      response.version = approved;
      response.status = "published";
      if (isRawFormat(c)) {
        return rawNodeBody(c, response, approvedRaw);
      }
      if (isMarkdownFormat(c)) {
        return c.body(nodeAsMarkdown(response, nodeId), 200, {
          "Content-Type": "text/markdown; charset=utf-8",
        });
      }
      return c.json({ node: response });
    }
    // Nothing approved yet. A public reader never gets here (canReadNode
    // refused them above), but an owner asking for approved_only would fall
    // through to their own draft — under a "this is what visitors see"
    // banner. The honest answer is the one a visitor gets: no such page.
    if (approvedOnly) {
      throw new NotFoundError("This document has no approved version yet.");
    }
  }

  // Resolved-from-DB workflow status; on-disk frontmatter status is
  // ignored entirely so the file never gets rewritten on workflow
  // transitions.
  response.status = node.pendingChange
    ? "external_edit_pending"
    : await versions.getDisplayStatus(nestId, nodeId);
  // Surface the pending review's submitter so the UI can hide the
  // approve/reject affordance from that user (SoD). Server enforces too.
  if (response.status === "pending_review") {
    const pending = await reviews.getPendingReview(nestId, nodeId);
    (response as any).pendingReviewBy = pending?.requestedBy ?? null;
  }
  // Latest deletion flag, pending or declined. Pending hides the doc view's
  // "Request deletion" button; declined carries the resolver's note, which is
  // the only way the person who asked learns the answer.
  (response as any).deletionRequest = await reviews.getLatestDeletionRequest(
    nestId,
    nodeId,
  );
  if (isRawFormat(c)) {
    // node.rawContent is the exact stored bytes (readDocument and the
    // drift-path loadLatestApprovedNode both come through parseDocument),
    // so frontmatter=1 prepends the block exactly as stored.
    return rawNodeBody(c, response, node.rawContent);
  }
  if (isMarkdownFormat(c)) {
    return c.body(nodeAsMarkdown(response, nodeId), 200, {
      "Content-Type": "text/markdown; charset=utf-8",
    });
  }
  return c.json({ node: response });
});

// PATCH /nests/:nestId/nodes/:nodeId — greedy catch-all; see the
// LinearRouter note on the GET route above.
nodeRoutes.patch("/:nodeId{.+}", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const body = await c.req.json<{
    content?: string;
    append?: string;
    tags?: string[];
    status?: string;
    title?: string;
    description?: string;
    changeNote?: string;
    schedule?: string;
    model?: string;
    prime?: boolean | null;
    client?: unknown;
    type?: string;
    assignee?: string | null;
    due?: string | null;
    priority?: string | null;
    parent?: string | null;
    fields?: Record<string, unknown>;
  }>();
  if (body.type !== undefined && typeof body.type !== "string") {
    throw new ValidationError("type must be a string");
  }

  // Org contributor (CU-wdqcq05rz6): admitted at read tier for this route
  // only. The edit is proposed as a draft for review; the published text
  // stays exactly as it is until a reviewer approves. Ahead of the
  // X-Base-Version check on purpose: that 409 names who last changed the
  // document and echoes the working version, which for a contributor could
  // be someone else's unapproved draft. proposeEdit's own checks decide.
  if (c.get("orgContribution") === true && c.get("nestPermission") === "read") {
    assertContributorPatch(body as Record<string, unknown>);
    await assertNotPushGated({
      nestId,
      userId: c.get("userId"),
      keyId: c.get("apiKeyId") ?? null,
      agentSurface: false,
    });
    const authorEmail = await getUserEmail(c);
    const { node, version, review } = await proposeEdit(
      nestId,
      nodeId,
      c.get("userId"),
      {
        content: body.content,
        append: body.append,
        title: body.title,
        description: body.description,
        tags: body.tags,
        changeNote: body.changeNote,
        client: attributeRequest(c, body.client),
      },
      authorEmail,
      { baseUrl: requestBaseUrl(c.req.url) },
    );
    return c.json({
      node: (await withComputedFields(nestId, [toNodeResponse(node)]))[0],
      version,
      review,
      org_contribution: true,
    });
  }

  // Conflict detection via X-Base-Version header — REST-only contract.
  const baseVersionHeader = c.req.header("X-Base-Version");
  if (baseVersionHeader) {
    const baseVersion = parseInt(baseVersionHeader, 10);
    const conflict = await versions.checkConflict(nestId, nodeId, baseVersion);
    if (conflict.conflict) {
      return c.json(
        {
          error: "Version conflict",
          your_version: baseVersion,
          current_version: conflict.currentVersion,
          updated_by: conflict.updatedBy,
          updated_at: conflict.updatedAt,
          rejected_content: body.content || body.append || null,
        },
        409,
      );
    }
  }

  const authorEmail = await getUserEmail(c);

  const { node, version: responseVersion } = await updateNode(
    nestId,
    nodeId,
    {
      content: body.content,
      append: body.append,
      tags: body.tags,
      title: body.title,
      description: body.description,
      status: body.status,
      changeNote: body.changeNote,
      schedule: body.schedule,
      model: body.model,
      prime: body.prime,
      client: attributeRequest(c, body.client),
      type: body.type,
      ...taskFieldsFromInput(body),
      ...customFieldsFromBody(body),
    },
    authorEmail,
  );

  return c.json({
    node: (await withComputedFields(nestId, [toNodeResponse(node)]))[0],
    version: responseVersion,
  });
});

// DELETE /nests/:nestId/nodes/:nodeId — greedy catch-all; see the
// LinearRouter note on the GET route above.
nodeRoutes.delete("/:nodeId{.+}", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  // The purge (storage docs, derived annotations node, governance rows,
  // tombstone) lives in the service so MCP's context_delete runs the same one.
  await deleteNode(nestId, nodeId, await getUserEmail(c), {
    client: attributeRequest(c, undefined),
  });
  return c.json({ deleted: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────

/** The `pdf:` block recorded in a (reconstructed) raw document, if any. */
function pdfMetaOf(nodeId: string, raw: string) {
  try {
    return parseDocument(`${nodeId}.md`, raw, nodeId).frontmatter.pdf;
  } catch {
    return undefined;
  }
}

async function getUserEmail(c: any): Promise<string> {
  const userId = c.get("userId");
  const db = getDb();
  const user = await db
    .get("SELECT email FROM users WHERE id = ?", [userId]) as { email: string } | undefined;
  return user?.email || "anonymous@localhost";
}
