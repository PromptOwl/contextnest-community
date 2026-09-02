/**
 * Push Confirmation Gate — HTTP routes (mounted at /nests/:nestId).
 *
 * Owns the real ctx-push endpoint POST /:nestId/publish and layers the gate on
 * top: on a nest with require_push_confirmation ON, a push from a
 * non-whitelisted key is HELD (202 pending_confirmation) instead of applied;
 * otherwise it applies immediately exactly as before (201). Plus the reviewer
 * surface to see, confirm, reject held pushes and manage the per-key allowlist.
 *
 * Mounted BEFORE queryRoutes so this /publish wins under the LinearRouter
 * (first registered match wins).
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { nestRequiresPushConfirmation } from "./service.js";
import {
  applyPublish,
  validatePublishPayload,
  type PublishPayload,
} from "../nodes/publish-apply.js";
import {
  createPendingPush,
  listPendingPushes,
  getPendingPush,
  getPendingPushRow,
  confirmPendingPush,
  rejectPendingPush,
  isPushAllowlisted,
  isNestReviewer,
  canConfirmPush,
  listPushAllowlist,
  removeFromPushAllowlist,
  type PendingPushStatus,
} from "./push-confirmation-service.js";
import { notifyPendingPush } from "../governance/notify-service.js";

export const pushRoutes = new Hono<AuthEnv>();

// POST /nests/:nestId/publish — the real ctx-push endpoint, now with the gate.
pushRoutes.post("/publish", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<PublishPayload>();
  validatePublishPayload(body);

  const userId = c.get("userId");
  const keyId = c.get("apiKeyId") ?? null;

  const gated = await nestRequiresPushConfirmation(nestId);
  const whitelisted = gated
    ? await isPushAllowlisted(nestId, userId, keyId)
    : false;

  if (gated && !whitelisted) {
    // HOLD the push: stage it, notify reviewers, and hand the CLI the poll
    // contract. Nothing is written to the nest until a reviewer confirms.
    const email = await resolveCallerEmail(userId);
    const label = c.get("apiKeyLabel") ?? email;
    const pending = await createPendingPush({
      nestId,
      submitterUserId: userId,
      submitterKeyId: keyId,
      submitterLabel: label,
      submitterEmail: email,
      payload: body,
    });

    // Best-effort: a notify failure must never fail the hold.
    try {
      await notifyPendingPush({
        nestId,
        pendingId: pending.id,
        submitterEmail: email,
        submitterLabel: label,
        docCount: pending.doc_count,
      });
    } catch (err) {
      console.error("[push] pending-push notify failed", nestId, err);
    }

    return c.json(
      {
        status: "pending_confirmation",
        pending_id: pending.id,
        confirm_url: `/nests/${nestId}/pending-pushes/${pending.id}/confirm`,
        poll_url: `/nests/${nestId}/pending-pushes/${pending.id}`,
        message:
          `This nest requires push confirmation. Your push of ${pending.doc_count} document(s) is held pending review — ` +
          `it will apply once a reviewer confirms it in the web UI.`,
        expires_at: pending.expires_at,
      },
      202,
    );
  }

  // Ungated (or a whitelisted key): apply immediately, same 201 as before.
  const result = await applyPublish(nestId, body);
  return c.json(result, 201);
});

// GET /nests/:nestId/pending-pushes?status= — reviewer view of held pushes.
pushRoutes.get("/pending-pushes", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const email = await resolveCallerEmail(userId);

  // Listing everyone's held pushes is a reviewer surface. A submitter reads its
  // OWN status via GET /pending-pushes/:pid, never the whole list.
  if (!(await isNestReviewer(nestId, userId, email))) {
    return c.json(
      { error: "Only a nest reviewer, owner, or admin can list pending pushes." },
      403,
    );
  }

  const statusRaw = c.req.query("status");
  const status =
    statusRaw === "pending" ||
    statusRaw === "applied" ||
    statusRaw === "rejected" ||
    statusRaw === "expired"
      ? (statusRaw as PendingPushStatus)
      : undefined;

  const pending = await listPendingPushes(nestId, status);
  return c.json({ pending_pushes: pending, count: pending.length });
});

// GET /nests/:nestId/pending-pushes/:pid — submitter-or-steward readable.
pushRoutes.get("/pending-pushes/:pid", async (c) => {
  const nestId = c.req.param("nestId")!;
  const pid = c.req.param("pid")!;
  const userId = c.get("userId");

  const row = await getPendingPushRow(nestId, pid);
  // Existence oracle: same 404 whether it's missing or the caller can't see it.
  if (!row) throw new NotFoundError("Pending push not found");

  const email = await resolveCallerEmail(userId);
  const allowed =
    row.submitter_user_id === userId ||
    (await isNestReviewer(nestId, userId, email));
  if (!allowed) throw new NotFoundError("Pending push not found");

  const view = await getPendingPush(nestId, pid);
  return c.json(view);
});

// POST /nests/:nestId/pending-pushes/:pid/confirm { always_allow? }
pushRoutes.post("/pending-pushes/:pid/confirm", async (c) => {
  const nestId = c.req.param("nestId")!;
  const pid = c.req.param("pid")!;
  const userId = c.get("userId");
  const email = await resolveCallerEmail(userId);

  const row = await getPendingPushRow(nestId, pid);
  if (!row) throw new NotFoundError("Pending push not found");

  if (
    !(await canConfirmPush({
      nestId,
      userId,
      userEmail: email,
      submitterUserId: row.submitter_user_id,
    }))
  ) {
    return c.json(
      { error: "You don't have permission to confirm this push." },
      403,
    );
  }

  const body = await c.req
    .json<{ always_allow?: boolean }>()
    .catch(() => ({}) as { always_allow?: boolean });

  const res = await confirmPendingPush(nestId, pid, userId, {
    alwaysAllow: !!body.always_allow,
  });
  if (!res.ok) {
    if (res.reason === "not_found")
      throw new NotFoundError("Pending push not found");
    // Already applied / rejected / expired — a lost race or a stale client.
    return c.json(
      {
        error:
          "This push is no longer pending — it may have already been confirmed, rejected, or expired.",
        status: row.status,
      },
      409,
    );
  }
  return c.json(res.view);
});

// POST /nests/:nestId/pending-pushes/:pid/reject
pushRoutes.post("/pending-pushes/:pid/reject", async (c) => {
  const nestId = c.req.param("nestId")!;
  const pid = c.req.param("pid")!;
  const userId = c.get("userId");
  const email = await resolveCallerEmail(userId);

  const row = await getPendingPushRow(nestId, pid);
  if (!row) throw new NotFoundError("Pending push not found");

  if (
    !(await canConfirmPush({
      nestId,
      userId,
      userEmail: email,
      submitterUserId: row.submitter_user_id,
    }))
  ) {
    return c.json(
      { error: "You don't have permission to reject this push." },
      403,
    );
  }

  const res = await rejectPendingPush(nestId, pid, userId);
  if (!res.ok) {
    if (res.reason === "not_found")
      throw new NotFoundError("Pending push not found");
    return c.json(
      {
        error:
          "This push is no longer pending — it may have already been confirmed, rejected, or expired.",
        status: row.status,
      },
      409,
    );
  }
  return c.json(res.view);
});

// GET /nests/:nestId/push-allowlist — reviewer view of whitelisted keys.
pushRoutes.get("/push-allowlist", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const email = await resolveCallerEmail(userId);
  if (!(await isNestReviewer(nestId, userId, email))) {
    return c.json(
      { error: "Only a nest reviewer, owner, or admin can view the push allowlist." },
      403,
    );
  }
  const allowlist = await listPushAllowlist(nestId);
  return c.json({ allowlist, count: allowlist.length });
});

// DELETE /nests/:nestId/push-allowlist { user_id, key_id? }
pushRoutes.delete("/push-allowlist", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const email = await resolveCallerEmail(userId);
  if (!(await isNestReviewer(nestId, userId, email))) {
    return c.json(
      { error: "Only a nest reviewer, owner, or admin can edit the push allowlist." },
      403,
    );
  }
  const body = await c.req
    .json<{ user_id?: string; key_id?: string | null }>()
    .catch(() => ({}) as { user_id?: string; key_id?: string | null });
  if (!body.user_id) throw new ValidationError("user_id is required");

  const removed = await removeFromPushAllowlist({
    nestId,
    userId: body.user_id,
    keyId: body.key_id ?? null,
  });
  return c.json({ removed });
});
