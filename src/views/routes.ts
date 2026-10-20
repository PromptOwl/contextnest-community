/**
 * §1.12 view serving — HTTP handlers (thin; the rules live in core.ts).
 *
 *   GET /nests/:nestId/nodes/:viewId/view/hosted[?v=N]
 *       The view page: blocks resolved for the viewer, server-rendered under
 *       `script-src 'none'`. html blocks become sandboxed frames.
 *   GET /nests/:nestId/nodes/:viewId/view/blocks/:blockId/hosted[?v=N]
 *       One html block's frame: the artifact's HTML with one injected
 *       `nest-data` element, under the no-popups artifact sandbox.
 *
 * Both paths end in `/hosted` on purpose: the headless access-key allowlist
 * (src/auth/headless.ts) already refuses every node `…/hosted` sub-resource,
 * so an access key gets the same 403 here that it gets on an artifact —
 * without touching that list. Mounted ahead of the annotation routes, whose
 * `/:nodeId{.+}/hosted` would otherwise read `<viewId>/view` as a node id;
 * when the id is not a view node, the handler falls through (next()) so an
 * artifact whose own id ends in `/view` still hosts exactly as before.
 *
 * Gates, in order: the nest middleware (non-members 404, traversal ids
 * rejected, doc/folder grantees confined to their grant), then the same
 * `canReadNode` /hosted uses, then filterAccessible for the viewer (which,
 * unlike canReadNode, narrows doc-grantees on ungoverned nests).
 */
import { Hono } from "hono";
import type { ContextNode } from "@promptowl/contextnest-engine";
import type { AuthEnv } from "../auth/middleware.js";
import { applyArtifactSandboxHeaders } from "../shared/artifact-sandbox.js";
import { canReadNode } from "../governance/access-guard.js";
import { getApprovedVersion } from "../governance/version-service.js";
import { recordNodeAccess } from "../governance/access-log.js";
import { isStewardshipEnabled } from "../nests/service.js";
import { engineCache } from "../nodes/engine.js";
import { readArtifact, resolveHostedNodeId } from "../annotations/service.js";
import {
  CAPS,
  findHtmlBlock,
  frameNestData,
  injectNestData,
  resolveBlocks,
  serializeNestData,
  type Principal,
} from "./core.js";
import { renderViewPage } from "./render.js";
import {
  authorInfos,
  createViewDeps,
  isSealedVersion,
  listVersionAuthors,
  liveViewVersion,
  readViewVersion,
  viewDataKillSwitch,
  viewerPrincipal,
  type ViewVersion,
} from "./deps.js";

export const viewRoutes = new Hono<AuthEnv>();

const VIEW_NODE_TYPE = "view";

/** The view page's CSP (spec §2.8). No `sandbox`: the page keeps the app
 *  origin so its frames' requests carry the session cookie (a sandboxed,
 *  opaque-origin parent would strip SameSite cookies from them). It runs no
 *  script at all; every byte of it is server-escaped. */
export const VIEW_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function decoded(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** ?v=N parsed exactly as /hosted parses it: a positive number pins, anything
 *  else (missing, junk) means the default. */
function versionParam(c: any): number | undefined {
  const vRaw = c.req.query("v");
  const vNum = vRaw !== undefined ? Number(vRaw) : NaN;
  return Number.isFinite(vNum) && vNum > 0 ? Math.floor(vNum) : undefined;
}

const pathOf = (id: string) => id.split("/").map(encodeURIComponent).join("/");

interface Served {
  nestId: string;
  viewId: string;
  viewer: Principal;
  layout: ViewVersion;
  /** The view version whose layout is served (null: a never-versioned live copy). */
  served: number | null;
  /** That version is a release (approved/published). */
  viewApproved: boolean;
  /** The ?v the caller asked for, echoed onto frame URLs. */
  pinned: number | undefined;
}

type Gate = { next: true } | { status: 403 | 404; error: string } | { served: Served };

/**
 * Everything both routes share: the view node, the gates, and which version's
 * layout to serve. A non-view id falls through to the next router.
 */
async function loadServedView(c: any): Promise<Gate> {
  const nestId = c.req.param("nestId")!;
  const viewId = await resolveHostedNodeId(nestId, decoded(c.req.param("nodeId") as string));
  const { storage } = await engineCache.get(nestId);
  let live: ContextNode;
  try {
    live = await storage.readDocument(viewId);
  } catch {
    return { next: true };
  }
  if ((live.frontmatter.type as string) !== VIEW_NODE_TYPE) return { next: true };

  const userId = c.get("userId");
  const viewer = await viewerPrincipal(nestId, userId);
  const deps = createViewDeps();
  if (
    !(await canReadNode(nestId, viewId, userId, viewer.email)) ||
    !(await deps.visible(nestId, [viewId], [viewer])).has(viewId)
  ) {
    return { status: 403, error: "Access denied" };
  }

  const pinned = versionParam(c);
  const liveVersion = typeof live.frontmatter.version === "number" ? live.frontmatter.version : null;
  let layout: ViewVersion;
  let served: number | null;
  let viewApproved: boolean;
  if (pinned !== undefined) {
    const sealed = await isSealedVersion(nestId, viewId, pinned);
    // A visibility-only reader may only pin a release, as everywhere else.
    if (viewer.approvedOnly && !sealed) return { status: 404, error: "Version not found" };
    try {
      layout = await readViewVersion(nestId, viewId, pinned);
    } catch {
      // An unsealed working copy is not in the chain; serve it when it is
      // exactly the version asked for.
      if (sealed || pinned !== liveVersion) return { status: 404, error: "Version not found" };
      layout = liveViewVersion(viewId, live);
    }
    served = pinned;
    viewApproved = sealed;
  } else {
    const approved = await getApprovedVersion(nestId, viewId);
    let fromChain: ViewVersion | null = null;
    if (approved != null) {
      try {
        fromChain = await readViewVersion(nestId, viewId, approved);
      } catch {
        fromChain = null;
      }
    }
    if (fromChain && approved != null) {
      layout = fromChain;
      served = approved;
      viewApproved = true;
    } else {
      if (viewer.approvedOnly) return { status: 404, error: "Not found" };
      layout = liveViewVersion(viewId, live);
      served = liveVersion;
      viewApproved = false;
    }
  }
  // A view written for agents only is not served to people.
  const audience = layout.meta?.audience;
  if (audience && !audience.includes("human")) return { status: 404, error: "Not found" };
  return { served: { nestId, viewId, viewer, layout, served, viewApproved, pinned } };
}

function viewerHeaders(c: any, served: number | null) {
  c.header("Cache-Control", "private, no-store");
  if (served != null) c.header("X-View-Snapshot", String(served));
}

// GET …/:viewId/view/hosted — the view page.
viewRoutes.get("/:nodeId{.+}/view/hosted", async (c, next) => {
  const gate = await loadServedView(c);
  if ("next" in gate) return next();
  if ("status" in gate) return c.json({ error: gate.error }, gate.status);
  const s = gate.served;
  const deps = createViewDeps();
  const blocks = s.layout.meta ? await resolveBlocks(s.layout.meta, s.nestId, [s.viewer], deps) : [];
  const q = s.pinned !== undefined ? `?v=${s.pinned}` : "";
  const html = renderViewPage({
    title: s.layout.title,
    intro: s.layout.body,
    blocks,
    frameUrl: (blockId) =>
      `/nests/${encodeURIComponent(s.nestId)}/nodes/${pathOf(s.viewId)}/view/blocks/${encodeURIComponent(blockId)}/hosted${q}`,
    truncated: !!s.layout.meta && s.layout.meta.blocks.length > CAPS.MAX_BLOCKS,
    invalidLayout: !s.layout.meta,
  });
  c.header("Content-Security-Policy", VIEW_PAGE_CSP);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  viewerHeaders(c, s.served);
  // One read event for the view per serve, recorded against the viewer.
  recordNodeAccess({
    nestId: s.nestId,
    nodeIds: [s.viewId],
    action: "read",
    surface: "api",
    userId: s.viewer.userId,
    userEmail: s.viewer.email,
    ...(s.served != null ? { versions: { [s.viewId]: s.served } } : {}),
    detail: "view page",
  });
  return c.html(html);
});

// GET …/:viewId/view/blocks/:blockId/hosted — one html block's frame.
viewRoutes.get("/:nodeId{.+}/view/blocks/:blockId/hosted", async (c, next) => {
  const gate = await loadServedView(c);
  if ("next" in gate) return next();
  if ("status" in gate) return c.json({ error: gate.error }, gate.status);
  const s = gate.served;
  const notFound = () => c.json({ error: "Not found" }, 404);
  if (!s.layout.meta) return notFound();
  const block = findHtmlBlock(s.layout.meta, decoded(c.req.param("blockId")!));
  if (!block) return notFound();

  // The artifact must be one the viewer can open in its own right.
  const deps = createViewDeps();
  let target: { id: string; type: string } | null = null;
  try {
    target = await deps.resolveRef(s.nestId, block.ref);
  } catch {
    target = null;
  }
  if (
    !target ||
    target.type !== "artifact" ||
    !(await canReadNode(s.nestId, target.id, s.viewer.userId, s.viewer.email)) ||
    !(await deps.visible(s.nestId, [target.id], [s.viewer])).has(target.id)
  ) {
    return notFound();
  }
  let artifact: Awaited<ReturnType<typeof readArtifact>>;
  try {
    artifact = await readArtifact(s.nestId, target.id);
  } catch {
    return notFound();
  }

  const killSwitch = viewDataKillSwitch();
  const stewardship = await isStewardshipEnabled(s.nestId);
  // Authors only matter when everything before them passed; looked up last.
  let authors: Awaited<ReturnType<typeof authorInfos>> = [];
  if (!killSwitch && !stewardship && s.viewApproved && artifact.approved && s.served != null && artifact.version != null) {
    authors = await authorInfos(s.nestId, [
      ...(await listVersionAuthors(s.nestId, s.viewId, s.served)),
      ...(await listVersionAuthors(s.nestId, target.id, artifact.version)),
    ]);
  }
  const { data } = await frameNestData({
    view: s.layout.meta,
    dataFrom: block.dataFrom,
    nestId: s.nestId,
    deps,
    trust: {
      stewardship,
      viewApproved: s.viewApproved,
      artifactApproved: artifact.approved,
      viewer: s.viewer,
      authors,
      killSwitch,
    },
  });
  const body = injectNestData(artifact.html, serializeNestData(data));
  applyArtifactSandboxHeaders(c, { popups: false });
  viewerHeaders(c, s.served);
  return c.html(body);
});
