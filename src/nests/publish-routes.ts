/**
 * Publish management API — create / list / inspect-views / revoke a public
 * link for a single document. Mounted at `/nests/:nestId/publications`
 * (POST `/nests/:nestId/publish` is already the nest-snapshot endpoint).
 *
 * Managing publishes is an owner/admin act (same authority as the steward
 * roster, via canManageStewards) — publishing exposes governed content on the
 * open web, so it is never available to a plain collaborator. The public
 * render/gate surface lives separately in publish-render-routes.ts under `/p`.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { canManageStewards } from "../governance/stewardship-service.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { sendEmailToRecipient, isEmailConfigured } from "../notify/email.js";
import {
  createPublish,
  listPublish,
  getPublishById,
  revokePublish,
  listViews,
  listAllowlist,
  toPublishResponse,
  type PublishMode,
} from "./publish-service.js";

export const publishRoutes = new Hono<AuthEnv>();

async function requireManage(c: any, nestId: string): Promise<void> {
  if (!(await canManageStewards(nestId, c.get("userId")))) {
    throw new ForbiddenError(
      "Only a nest admin, the nest owner, or the server admin can publish documents.",
    );
  }
}

// POST /nests/:nestId/publish — publish a document at a public/gated link.
publishRoutes.post("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireManage(c, nestId);
  const body = await c.req.json<{
    node_id?: string;
    access_mode?: string;
    comments_enabled?: boolean;
    watermark?: boolean;
    no_download?: boolean;
    code?: string | null;
    allowlist?: string[];
    expires_at?: string | null;
  }>();

  const mode = (body.access_mode ?? "public") as PublishMode;
  // An email or invite link is opened ONLY by clicking a mailed magic link, so
  // without a mail transport it is a link nobody — not even the person who was
  // invited — can ever open. Refuse it rather than hand back a dead link.
  if ((mode === "email" || mode === "invite") && !isEmailConfigured()) {
    throw new ValidationError(
      "Email and invite links need email set up on this server (SMTP or AWS SES, plus NOTIFY_EMAIL_FROM). Use a public or passcode link instead.",
    );
  }
  const row = await createPublish({
    nestId,
    nodeId: (body.node_id ?? "").trim(),
    mode,
    commentsEnabled: !!body.comments_enabled,
    watermark: !!body.watermark,
    noDownload: !!body.no_download,
    code: body.code ?? null,
    allowlist: Array.isArray(body.allowlist) ? body.allowlist : [],
    expiresAt: body.expires_at ?? null,
    createdBy: c.get("userId"),
  });
  const link = `${requestBaseUrl(c.req.url)}/p/${row.slug}`;

  // Invite mode is useless without the invitation: an allow-listed reader who
  // never receives the link has no way to reach the document. Fire-and-forget,
  // like every other notification here — a dead SMTP config must not fail the
  // publish (the link still works for anyone who has it).
  if (mode === "invite") {
    for (const email of await listAllowlist(row.id)) {
      void sendEmailToRecipient(email, {
        status: "shared",
        docTitle: "A document has been shared with you",
        path: "PromptOwl · ContextNest",
        permission: "view",
        link,
      });
    }
  }
  return c.json({ publish: toPublishResponse(row), link }, 201);
});

// GET /nests/:nestId/publish — the publishes for this nest, with their links.
publishRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireManage(c, nestId);
  const base = requestBaseUrl(c.req.url);
  const rows = await listPublish(nestId);
  return c.json({
    count: rows.length,
    publishes: rows.map((r) => ({ ...toPublishResponse(r), link: `${base}/p/${r.slug}` })),
  });
});

// GET /nests/:nestId/publish/:id/views — who opened it, when.
publishRoutes.get("/:id/views", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireManage(c, nestId);
  const row = await getPublishById(nestId, c.req.param("id")!);
  if (!row) throw new NotFoundError("Publish not found");
  const views = await listViews(row.id);
  return c.json({ count: views.length, views });
});

// DELETE /nests/:nestId/publish/:id — revoke the link.
publishRoutes.delete("/:id", async (c) => {
  const nestId = c.req.param("nestId")!;
  await requireManage(c, nestId);
  const ok = await revokePublish(nestId, c.req.param("id")!);
  if (!ok) throw new NotFoundError("Publish not found");
  return c.json({ revoked: true });
});
