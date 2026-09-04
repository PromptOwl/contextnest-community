import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { engineCache } from "./engine.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
// SECURITY: `:nodeId` params on these routes become filesystem paths in the
// engine's storage layer (join(nestRoot, id + ".md"), no containment). A `../`
// id is rejected up front by the assertSafeNodeId chokepoint mounted on
// /nests/:nestId/nodes/:nodeId{.+} in app.ts — covers every node route across
// this + the annotations + governance routers, so handlers here can trust nodeId.
import { trackEvent } from "../telemetry/tracker.js";
import { getDb } from "../db/client.js";
import * as versions from "../governance/version-service.js";
import * as stewardship from "../governance/stewardship-service.js";
import * as reviews from "../governance/review-service.js";
import {
  resolveCallerEmail,
  canReadNode,
} from "../governance/access-guard.js";
import { isPublicReader } from "../shared/access.js";
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
  listNodesForCaller,
  nestCensus,
  getNodeForCaller,
  resolveAuthorship,
  toNodeResponse,
  bodyOnly,
} from "./service.js";

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
  });
  // The nest-wide shape is NOT bundled here: it describes the whole nest
  // whatever level was asked for, so bundling recomputed it on every folder
  // expand. It has its own endpoint and its own cache entry.
  return c.json({ count: nodes.length, nodes });
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
    folder?: string;
    prime?: boolean;
  }>();

  if (!body.title || !body.content) {
    throw new ValidationError("title and content are required");
  }
  if (body.folder !== undefined && typeof body.folder !== "string") {
    throw new ValidationError("folder must be a string path like \"gtm/deals\"");
  }

  const nestId = c.req.param("nestId")!;
  const authorEmail = await getUserEmail(c);
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
      folder: body.folder,
      prime: body.prime,
    },
    authorEmail,
  );

  // Resolve stewards for the response
  const resolved = await stewardship.resolveStewardsForNode(nestId, node.id);

  return c.json({
    node: toNodeResponse(node),
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

// GET /nests/:nestId/nodes/:nodeId/stewards
nodeRoutes.get("/:nodeId{.+}/stewards", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;

  const { resolveStewardsWithFallback } = await import("../governance/stewardship-service.js");
  const { stewards, fallbackToOwner, ownerEmail } = await resolveStewardsWithFallback(
    nestId,
    nodeId,
  );
  return c.json({
    nodeId,
    stewards: stewards.map((r: any) => ({
      email: r.steward.userEmail,
      role: r.steward.role,
      scope: r.steward.scope,
      source: r.source,
      priority: r.priority,
    })),
    fallbackToOwner,
    ownerEmail,
  });
});

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
  const { versions: versionManager } = await engineCache.get(nestId);

  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) {
    return c.json(
      { error: "Access denied — no steward assignment for this node" },
      403,
    );
  }

  const body = await c.req
    .json<{ targetVersion?: number }>()
    .catch(() => ({}) as { targetVersion?: number });
  const targetVersion = Number(body.targetVersion);
  if (!Number.isInteger(targetVersion) || targetVersion < 1) {
    throw new ValidationError("targetVersion (a positive integer) is required");
  }

  let raw: string;
  try {
    raw = await versionManager.reconstructVersion(nodeId, targetVersion);
  } catch {
    throw new NotFoundError(
      `Version ${targetVersion} not found for ${nodeId}`,
    );
  }
  const content = bodyOnly(nodeId, raw);
  const { node, version } = await updateNode(
    nestId,
    nodeId,
    { content, changeNote: `Restored from version ${targetVersion}` },
    userEmail,
  );
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
  const response = toNodeResponse(node);
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

  // Public readers see approved version body only.
  if (publicReader) {
    const approved = await versions.getApprovedVersion(nestId, nodeId);
    if (approved != null) {
      // Kept for the raw path: frontmatter=1 must serve the APPROVED
      // snapshot's stored frontmatter, never the live working copy's.
      let approvedRaw = "";
      try {
        approvedRaw = await versionManager.reconstructVersion(
          nodeId,
          approved,
        );
        response.content = bodyOnly(nodeId, approvedRaw);
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
    changeNote?: string;
    schedule?: string;
    prime?: boolean | null;
  }>();

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
      status: body.status,
      changeNote: body.changeNote,
      schedule: body.schedule,
      prime: body.prime,
    },
    authorEmail,
  );

  return c.json({ node: toNodeResponse(node), version: responseVersion });
});

// DELETE /nests/:nestId/nodes/:nodeId — greedy catch-all; see the
// LinearRouter note on the GET route above.
nodeRoutes.delete("/:nodeId{.+}", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  // The purge (storage docs, derived annotations node, governance rows,
  // tombstone) lives in the service so MCP's context_delete runs the same one.
  await deleteNode(nestId, nodeId, await getUserEmail(c));
  return c.json({ deleted: true });
});

// ─── Helpers ────────────────────────────────────────────────────────────

async function getUserEmail(c: any): Promise<string> {
  const userId = c.get("userId");
  const db = getDb();
  const user = await db
    .get("SELECT email FROM users WHERE id = ?", [userId]) as { email: string } | undefined;
  return user?.email || "anonymous@localhost";
}
