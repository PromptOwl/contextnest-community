import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { ValidationError } from "../shared/errors.js";
import { applyArtifactSandboxHeaders } from "../shared/artifact-sandbox.js";
import { injectArtifactBridge } from "../shared/artifact-bridge.js";
import { resolveCallerEmail, canReadNode } from "../governance/access-guard.js";
import {
  createThread,
  addComment,
  setThreadStatus,
  listThreads,
  syncAnnotationsNode,
  readArtifact,
  resolveHostedNodeId,
} from "./service.js";
import { ARTIFACT_NODE_TYPE, type AnnotationAnchor } from "./types.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { attributeRequest } from "../shared/client-metadata.js";
import { channelPostRefusal } from "../channels/channel-service.js";
import { messageClient } from "../channels/message-meta.js";
import { fanOutPostedMessage } from "../channels/post-message.js";

/**
 * Routes for hosted-artifact annotations + sandboxed serving.
 *
 * Mounted at /nests/:nestId/nodes (BEFORE the greedy nodeRoutes catch-all).
 * Annotating is a READ-tier collaboration action: the per-nest middleware in
 * app.ts (isAnnotationAction) deliberately admits these POSTs at read so a
 * read-only reviewer can comment. Each handler therefore enforces node
 * read-access itself, so you can't annotate a node you can't see.
 *
 * On a channel node (agent team stream) the same routes are how people post,
 * and `channelPostRefusal` narrows them to people added to the nest; a
 * visibility-only reader never passes `canReadNode` for a channel at all.
 *
 * Posting answers `{ thread, comment_id, mentions }`: the message's id, and
 * what each @name in it reached (channels/post-message.ts).
 */
export const annotationRoutes = new Hono<AuthEnv>();

function getNodeId(c: any): string {
  const raw = c.req.param("nodeId") as string;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// GET /nests/:nestId/nodes/:nodeId/annotations — list threads
annotationRoutes.get("/:nodeId{.+}/annotations", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = getNodeId(c);
  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) {
    return c.json({ error: "Access denied" }, 403);
  }
  return c.json({ threads: await listThreads(nestId, nodeId) });
});

// POST /nests/:nestId/nodes/:nodeId/annotations — create a thread (anchored or whole-artifact)
annotationRoutes.post("/:nodeId{.+}/annotations", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = getNodeId(c);
  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) {
    return c.json({ error: "Access denied" }, 403);
  }

  // A channel takes posts from people added to the nest only.
  const refusal = await channelPostRefusal(nestId, nodeId, userId, userEmail);
  if (refusal) return c.json({ error: refusal.error }, refusal.status);

  const input = await c.req.json<{
    body?: string;
    anchor?: Partial<AnnotationAnchor> | null;
    snapshotVersion?: number | null;
    client?: unknown;
  }>();
  if (!input.body || !input.body.trim()) {
    throw new ValidationError("body is required");
  }

  const thread = await createThread(
    nestId,
    nodeId,
    {
      body: input.body,
      anchor: (input.anchor as AnnotationAnchor) ?? null,
      snapshotVersion: input.snapshotVersion ?? null,
    },
    userEmail,
    // Who wrote it on the person's behalf, when the caller says so — the
    // channel timeline's "<agent>, on behalf of <human>". A bare key label is
    // kept beside it, not shown as an agent (message-meta.ts).
    messageClient(attributeRequest(c, input.client), input.client, c.get("apiKeyLabel")),
  );
  const posted = await fanOutPostedMessage({
    nestId,
    nodeId,
    thread,
    isReply: false,
    body: input.body,
    authorEmail: userEmail,
    baseUrl: requestBaseUrl(c.req.url),
  });
  return c.json({ thread, comment_id: posted.comment_id, mentions: posted.mentions }, 201);
});

// POST /nests/:nestId/nodes/:nodeId/annotations/:threadId/comments — reply.
// The handler body is exported: RegExpRouter's greedy param merge routes this
// URL shape to the governance POST /:nodeId{.+}/comments route (the greedy
// nodeId swallows "…/annotations/<threadId>"), which detects the shape and
// delegates here. The direct registration below still serves routers that
// match it natively.
export async function handleAnnotationReply(
  c: any,
  nodeId: string,
  threadId: string,
): Promise<Response> {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) {
    return c.json({ error: "Access denied" }, 403);
  }

  const refusal = await channelPostRefusal(nestId, nodeId, userId, userEmail);
  if (refusal) return c.json({ error: refusal.error }, refusal.status);

  const input = (await c.req.json()) as { body?: string; client?: unknown };
  if (!input.body || !input.body.trim()) {
    throw new ValidationError("body is required");
  }

  // addComment also reopens the thread when it was resolved.
  const thread = await addComment(
    nestId,
    nodeId,
    threadId,
    userEmail,
    input.body,
    messageClient(attributeRequest(c, input.client), input.client, c.get("apiKeyLabel")),
  );
  // @mentions in the reply; on a document also everyone already in the
  // thread, its watchers and reviewer stewards.
  const posted = await fanOutPostedMessage({
    nestId,
    nodeId,
    thread,
    isReply: true,
    body: input.body,
    authorEmail: userEmail,
    baseUrl: requestBaseUrl(c.req.url),
  });
  return c.json({ thread, comment_id: posted.comment_id, mentions: posted.mentions });
}

annotationRoutes.post("/:nodeId{.+}/annotations/:threadId/comments", async (c) =>
  handleAnnotationReply(c, getNodeId(c), c.req.param("threadId")!),
);

// POST /nests/:nestId/nodes/:nodeId/annotations/:threadId/resolve
annotationRoutes.post("/:nodeId{.+}/annotations/:threadId/resolve", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = getNodeId(c);
  const threadId = c.req.param("threadId")!;
  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) {
    return c.json({ error: "Access denied" }, 403);
  }
  const refusal = await channelPostRefusal(nestId, nodeId, userId, userEmail);
  if (refusal) return c.json({ error: refusal.error }, refusal.status);

  const thread = await setThreadStatus(nestId, nodeId, threadId, "resolved", userEmail);
  await syncAnnotationsNode(nestId, nodeId, userEmail);
  return c.json({ thread });
});

// POST /nests/:nestId/nodes/:nodeId/annotations/:threadId/reopen
annotationRoutes.post("/:nodeId{.+}/annotations/:threadId/reopen", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = getNodeId(c);
  const threadId = c.req.param("threadId")!;
  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) {
    return c.json({ error: "Access denied" }, 403);
  }
  const refusal = await channelPostRefusal(nestId, nodeId, userId, userEmail);
  if (refusal) return c.json({ error: refusal.error }, refusal.status);

  const thread = await setThreadStatus(nestId, nodeId, threadId, "open", userEmail);
  await syncAnnotationsNode(nestId, nodeId, userEmail);
  return c.json({ thread });
});

// GET /nests/:nestId/nodes/:nodeId/hosted — serve the artifact HTML, sandboxed.
// The `sandbox` CSP directive forces an opaque origin (no access to host
// cookies/storage) even when embedded or opened directly. Scripts run, but
// can't reach the nest's session. Self-hosted contains blast radius further.
annotationRoutes.get("/:nodeId{.+}/hosted", async (c) => {
  const nestId = c.req.param("nestId")!;
  // Resolved BEFORE the access check, so the gate always sees the real id.
  const nodeId = await resolveHostedNodeId(nestId, getNodeId(c));
  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);
  if (!(await canReadNode(nestId, nodeId, userId, userEmail))) {
    return c.json({ error: "Access denied" }, 403);
  }

  // Optional ?v=N pins a frozen snapshot; otherwise the approved version.
  const vRaw = c.req.query("v");
  const vNum = vRaw !== undefined ? Number(vRaw) : NaN;
  const version =
    Number.isFinite(vNum) && vNum > 0 ? Math.floor(vNum) : undefined;

  const { html, version: served, type } = await readArtifact(
    nestId,
    nodeId,
    version,
  );
  // Only genuine artifact nodes render through the HTML host path. A live doc
  // of another kind (ordinary markdown) is not served as HTML. When the live
  // doc is gone (type === null) we still serve the reconstructed snapshot.
  if (type !== null && type !== ARTIFACT_NODE_TYPE) {
    return c.json({ error: "Not a hosted artifact" }, 404);
  }
  // Strict, self-contained CSP — shared with the node `?format=raw` artifact
  // path so the sandbox policy can't drift between the two HTML-serving
  // surfaces. See src/shared/artifact-sandbox.ts for the full rationale.
  applyArtifactSandboxHeaders(c);
  if (served != null) c.header("X-Artifact-Snapshot", String(served));
  // ?embed=1 — the in-app viewer's iframe: append the place/highlight bridge
  // (see src/shared/artifact-bridge.ts). Everyone else gets the bytes as-is.
  // Exactly "1" on purpose: an internal flag only the viewer sends, so any
  // other value (embed=true, embed=) serves the plain page rather than guess.
  return c.html(c.req.query("embed") === "1" ? injectArtifactBridge(html) : html);
});
