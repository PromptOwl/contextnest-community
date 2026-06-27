import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { ValidationError } from "../shared/errors.js";
import { resolveCallerEmail, canReadNode } from "../governance/access-guard.js";
import {
  createThread,
  addComment,
  setThreadStatus,
  listThreads,
  syncAnnotationsNode,
  readArtifact,
} from "./service.js";
import type { AnnotationAnchor } from "./types.js";

/**
 * Routes for hosted-artifact annotations + sandboxed serving.
 *
 * Mounted at /nests/:nestId/nodes (BEFORE the greedy nodeRoutes catch-all).
 * Writes are gated to `write` permission by the per-nest middleware in app.ts;
 * here we additionally enforce node read-access so you can't annotate a node
 * you can't see.
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
  const userEmail = resolveCallerEmail(userId);
  if (!canReadNode(nestId, nodeId, userId, userEmail)) {
    return c.json({ error: "Access denied" }, 403);
  }
  return c.json({ threads: listThreads(nestId, nodeId) });
});

// POST /nests/:nestId/nodes/:nodeId/annotations — create a thread (anchored or whole-artifact)
annotationRoutes.post("/:nodeId{.+}/annotations", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = getNodeId(c);
  const userId = c.get("userId");
  const userEmail = resolveCallerEmail(userId);
  if (!canReadNode(nestId, nodeId, userId, userEmail)) {
    return c.json({ error: "Access denied" }, 403);
  }

  const input = await c.req.json<{
    body?: string;
    anchor?: Partial<AnnotationAnchor> | null;
    snapshotVersion?: number | null;
  }>();
  if (!input.body || !input.body.trim()) {
    throw new ValidationError("body is required");
  }

  const thread = createThread(
    nestId,
    nodeId,
    {
      body: input.body,
      anchor: (input.anchor as AnnotationAnchor) ?? null,
      snapshotVersion: input.snapshotVersion ?? null,
    },
    userEmail,
  );
  await syncAnnotationsNode(nestId, nodeId, userEmail);
  return c.json({ thread }, 201);
});

// POST /nests/:nestId/nodes/:nodeId/annotations/:threadId/comments — reply
annotationRoutes.post("/:nodeId{.+}/annotations/:threadId/comments", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = getNodeId(c);
  const threadId = c.req.param("threadId")!;
  const userId = c.get("userId");
  const userEmail = resolveCallerEmail(userId);
  if (!canReadNode(nestId, nodeId, userId, userEmail)) {
    return c.json({ error: "Access denied" }, 403);
  }

  const input = await c.req.json<{ body?: string }>();
  if (!input.body || !input.body.trim()) {
    throw new ValidationError("body is required");
  }

  const thread = addComment(threadId, userEmail, input.body);
  await syncAnnotationsNode(nestId, nodeId, userEmail);
  return c.json({ thread });
});

// POST /nests/:nestId/nodes/:nodeId/annotations/:threadId/resolve
annotationRoutes.post("/:nodeId{.+}/annotations/:threadId/resolve", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = getNodeId(c);
  const threadId = c.req.param("threadId")!;
  const userId = c.get("userId");
  const userEmail = resolveCallerEmail(userId);
  if (!canReadNode(nestId, nodeId, userId, userEmail)) {
    return c.json({ error: "Access denied" }, 403);
  }

  const thread = setThreadStatus(threadId, "resolved", userEmail);
  await syncAnnotationsNode(nestId, nodeId, userEmail);
  return c.json({ thread });
});

// POST /nests/:nestId/nodes/:nodeId/annotations/:threadId/reopen
annotationRoutes.post("/:nodeId{.+}/annotations/:threadId/reopen", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = getNodeId(c);
  const threadId = c.req.param("threadId")!;
  const userId = c.get("userId");
  const userEmail = resolveCallerEmail(userId);
  if (!canReadNode(nestId, nodeId, userId, userEmail)) {
    return c.json({ error: "Access denied" }, 403);
  }

  const thread = setThreadStatus(threadId, "open", userEmail);
  await syncAnnotationsNode(nestId, nodeId, userEmail);
  return c.json({ thread });
});

// GET /nests/:nestId/nodes/:nodeId/hosted — serve the artifact HTML, sandboxed.
// The `sandbox` CSP directive forces an opaque origin (no access to host
// cookies/storage) even when embedded or opened directly. Scripts run, but
// can't reach the nest's session. Self-hosted contains blast radius further.
annotationRoutes.get("/:nodeId{.+}/hosted", async (c) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = getNodeId(c);
  const userId = c.get("userId");
  const userEmail = resolveCallerEmail(userId);
  if (!canReadNode(nestId, nodeId, userId, userEmail)) {
    return c.json({ error: "Access denied" }, 403);
  }

  const { html } = await readArtifact(nestId, nodeId);
  c.header(
    "Content-Security-Policy",
    "sandbox allow-scripts allow-popups allow-forms allow-modals",
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(html);
});
