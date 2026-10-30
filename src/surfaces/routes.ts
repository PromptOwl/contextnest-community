/**
 * Surfaces REST (PRD §5.4, S1 part): status, bindings CRUD + preview /
 * recheck / resume, identity links list / revoke / unblock, link reviews, and
 * the one-time link page. Mounted at /surfaces and /link in app.ts behind
 * flexAuthMiddleware; every route 404s while FEATURE_SURFACES is off.
 *
 * Route prefix: this server has no /api prefix — top-level routers
 * (/teams, /people, /systems, /admin/*) — so Surfaces follows that (V17).
 */
import { Hono, type Context } from "hono";
import { createHmac, timingSafeEqual } from "crypto";
import type { AuthEnv } from "../auth/middleware.js";
import { getSessionIdFromRequest } from "../auth/sessions.js";
import { credentialMayContribute } from "../governance/org-contribution.js";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { surfacesEnabled } from "./flags.js";
import {
  UnprocessableError,
  GuardRefusedError,
  SERVER_ADMIN_DISCLOSURE,
  createBinding,
  getBinding,
  getBindingRow,
  isOrgAdmin,
  listBindings,
  previewBinding,
  recheckBinding,
  removeBinding,
  resumeBinding,
  updateBinding,
  bindingView,
  canAdministerNest,
} from "./services/binding-service.js";
import {
  clearAutoMatchBlock,
  decideLinkReview,
  describeLinkToken,
  getLink,
  listLinkReviews,
  listLinks,
  redeemLinkToken,
  revokeLink,
} from "./services/identity-service.js";
import { listInstalls } from "./services/install-store.js";

type C = Context<AuthEnv>;

function bool(v: unknown, field: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ValidationError(`${field} must be true or false`);
  return v;
}
function str(v: unknown, field: string, required = true): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ValidationError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.length > 200) throw new ValidationError(`${field} must be a string`);
  return v;
}

/** A nest-scoped key may only touch its own nest. */
function assertScope(c: C, nestId: string) {
  const scope = c.get("nestScope");
  if (scope && scope !== nestId) throw new ForbiddenError("This key is scoped to a different nest.");
}

function handleError(c: C, err: unknown) {
  if (err instanceof GuardRefusedError) {
    return c.json(
      { error: err.message, code: "guard_refused", guard: err.guard, guard_detail: err.guard.detail, disclosure: SERVER_ADMIN_DISCLOSURE },
      409,
    );
  }
  if (err instanceof AppError) return c.json({ error: err.message }, err.statusCode as any);
  throw err;
}

async function readBody(c: C): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => ({}));
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export const surfacesRoutes = new Hono<AuthEnv>();

surfacesRoutes.use("*", async (c, next) => {
  if (!surfacesEnabled()) return c.json({ error: "Not found" }, 404);
  // Read-only keys read and nothing more — the same rule and words as the
  // /nests gate (app.ts). Nest-scoped keys never reach /surfaces at all: the
  // app-wide nestScopedKeyGuard refuses every path outside their nest.
  if (c.get("keyCapability") === "read" && c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.json({ error: "This API key is read-only and cannot perform write or governance actions." }, 403);
  }
  return next();
});

/** Org-level identity actions need a person's own full credential: a
 *  session, an unscoped read-write personal key or an OAuth grant (M2). */
function assertPersonCredential(c: C) {
  if (!credentialMayContribute(c)) {
    throw new ForbiddenError("Identity links can only be managed with your own full credential (a session or an unscoped read-write key).");
  }
}

/** The listener is created server-side for a binding; a client can never name one (M3). */
function refuseListener(b: Record<string, unknown>) {
  if (b.listener_agent_node_id !== undefined && b.listener_agent_node_id !== null) {
    throw new UnprocessableError("listener_agent_node_id is set by the server for the binding's own listener; it can't be supplied.");
  }
}

surfacesRoutes.get("/status", async (c) => {
  try {
    const userId = c.get("userId");
    const bindings = await listBindings(userId);
    const orgAdmin = (await isOrgAdmin(userId)) && !c.get("nestScope");
    const installs = orgAdmin
      ? (await listInstalls()).map((i) => ({ id: i.id, surface: i.surface, mode: i.mode, status: i.status, home_nest_id: i.home_nest_id }))
      : [];
    const by = (s: string) => bindings.filter((b) => b.status === s).length;
    return c.json({
      enabled: true,
      installs,
      bindings: {
        total: bindings.length,
        active: by("active"),
        paused_guard: by("paused_guard"),
        paused_by_member: by("paused_by_member"),
        removed: by("removed"),
      },
      disclosure: SERVER_ADMIN_DISCLOSURE,
    });
  } catch (err) {
    return handleError(c, err);
  }
});

function bindInput(c: C, b: Record<string, unknown>) {
  refuseListener(b);
  const nestId = str(b.nest_id, "nest_id")!;
  assertScope(c, nestId);
  return {
    actorUserId: c.get("userId"),
    installId: str(b.install_id, "install_id")!,
    conversationId: str(b.conversation_id, "conversation_id")!,
    nestId,
    explicitPublicBind: bool(b.explicit_public_bind, "explicit_public_bind"),
    extCaptureEnabled: bool(b.ext_capture_enabled, "ext_capture_enabled"),
  };
}

surfacesRoutes.get("/bindings", async (c) => {
  try {
    const nestId = c.req.query("nest_id") || undefined;
    if (nestId) assertScope(c, nestId);
    const scope = c.get("nestScope");
    return c.json({ bindings: await listBindings(c.get("userId"), { nestId: nestId ?? scope ?? undefined }) });
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.post("/bindings/preview", async (c) => {
  try {
    return c.json(await previewBinding(bindInput(c, await readBody(c))));
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.post("/bindings", async (c) => {
  try {
    return c.json(await createBinding(bindInput(c, await readBody(c))), 201);
  } catch (err) {
    return handleError(c, err);
  }
});

async function scopedRow(c: C, id: string) {
  const row = await getBindingRow(id);
  if (!row) throw new NotFoundError("Binding not found");
  assertScope(c, row.nest_id);
  return row;
}

surfacesRoutes.get("/bindings/:id", async (c) => {
  try {
    await scopedRow(c, c.req.param("id"));
    return c.json(await getBinding(c.req.param("id"), c.get("userId")));
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.patch("/bindings/:id", async (c) => {
  try {
    await scopedRow(c, c.req.param("id"));
    const b = await readBody(c);
    refuseListener(b);
    return c.json(
      await updateBinding(c.req.param("id"), c.get("userId"), {
        explicitPublicBind: bool(b.explicit_public_bind, "explicit_public_bind"),
        extCaptureEnabled: bool(b.ext_capture_enabled, "ext_capture_enabled"),
        conversationName: b.conversation_name === undefined ? undefined : (str(b.conversation_name, "conversation_name", false) ?? null),
      }),
    );
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.delete("/bindings/:id", async (c) => {
  try {
    await scopedRow(c, c.req.param("id"));
    return c.json(await removeBinding(c.req.param("id"), c.get("userId")));
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.post("/bindings/:id/recheck", async (c) => {
  try {
    const row = await scopedRow(c, c.req.param("id"));
    if (!(await canAdministerNest(row.nest_id, c.get("userId")))) throw new ForbiddenError("Only an owner or admin of this nest can re-check it.");
    return c.json({ binding: await bindingView(await recheckBinding(row.id)) });
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.post("/bindings/:id/resume", async (c) => {
  try {
    await scopedRow(c, c.req.param("id"));
    return c.json(await resumeBinding(c.req.param("id"), c.get("userId")));
  } catch (err) {
    return handleError(c, err);
  }
});

// ─── identity links ────────────────────────────────────────────────────────

function linkView(l: Awaited<ReturnType<typeof listLinks>>[number]) {
  return {
    id: l.id,
    install_id: l.install_id,
    surface: l.surface,
    surface_user_id: l.surface_user_id,
    community_user_id: l.community_user_id,
    method: l.method,
    status: l.status,
    first_use_confirmed: !!l.first_use_confirmed_at,
    auto_match_blocked: !!l.auto_match_blocked,
    revoked_at: l.revoked_at,
    created_at: l.created_at,
  };
}

/** Org admins see every link; anyone else sees their own. */
surfacesRoutes.get("/links", async (c) => {
  try {
    assertPersonCredential(c);
    const userId = c.get("userId");
    const admin = await isOrgAdmin(userId);
    const links = await listLinks(admin ? {} : { communityUserId: userId });
    return c.json({ links: links.map(linkView) });
  } catch (err) {
    return handleError(c, err);
  }
});

/** Revoke: an org admin, or the linked person themself. Immediate. */
surfacesRoutes.delete("/links/:id", async (c) => {
  try {
    assertPersonCredential(c);
    const userId = c.get("userId");
    const link = await getLink(c.req.param("id"));
    if (!link) throw new NotFoundError("Link not found");
    if (!(await isOrgAdmin(userId)) && link.community_user_id !== userId) throw new ForbiddenError("Only an administrator or the linked person can revoke this link.");
    const reason = c.req.query("reason") ?? null;
    return c.json({ link: linkView(await revokeLink({ linkId: link.id, byUserId: userId, reason })) });
  } catch (err) {
    return handleError(c, err);
  }
});

/** Admin clears auto_match_blocked so a revoked pair may auto-match again. */
surfacesRoutes.post("/links/unblock", async (c) => {
  try {
    assertPersonCredential(c);
    if (!(await isOrgAdmin(c.get("userId")))) throw new ForbiddenError("Administrators only.");
    const b = await readBody(c);
    const n = await clearAutoMatchBlock(str(b.install_id, "install_id")!, str(b.surface_user_id, "surface_user_id")!);
    return c.json({ cleared: n });
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.get("/link-reviews", async (c) => {
  try {
    assertPersonCredential(c);
    if (!(await isOrgAdmin(c.get("userId")))) throw new ForbiddenError("Administrators only.");
    return c.json({ reviews: await listLinkReviews(c.req.query("status") ?? "pending") });
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.post("/link-reviews/:id", async (c) => {
  try {
    assertPersonCredential(c);
    if (!(await isOrgAdmin(c.get("userId")))) throw new ForbiddenError("Administrators only.");
    const b = await readBody(c);
    const decision = str(b.decision, "decision") as "approve" | "deny";
    const out = await decideLinkReview({ reviewId: c.req.param("id"), decision, byUserId: c.get("userId") });
    return c.json({ review: out.review, link: out.link ? linkView(out.link) : null });
  } catch (err) {
    return handleError(c, err);
  }
});

// ─── one-time link page (/link/:token) ─────────────────────────────────────

/** CSRF: HMAC over the token, keyed by the session id (httpOnly, unreadable
 *  cross-origin). A Bearer caller has no ambient credential to ride, so its
 *  token is keyed by the user id. */
function linkCsrf(c: C, token: string): string {
  const key = getSessionIdFromRequest(c) ?? `bearer:${c.get("userId")}`;
  return createHmac("sha256", key).update(JSON.stringify(["surface-link", token])).digest("hex");
}
function csrfOk(c: C, token: string, presented: unknown): boolean {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(linkCsrf(c, token));
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}
const wantsHtml = (c: C) => (c.req.header("Accept") || "").includes("text/html");
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#111}button{padding:8px 16px}</style></head><body>${body}</body></html>`;
}

export const linkPageRoutes = new Hono<AuthEnv>();

linkPageRoutes.use("*", async (c, next) => {
  if (!surfacesEnabled()) return c.json({ error: "Not found" }, 404);
  return next();
});

linkPageRoutes.get("/:token", async (c) => {
  const token = c.req.param("token");
  const d = await describeLinkToken(token, c.get("userId"));
  if (!d.ok) {
    const msg = d.reason === "expired" ? "This link has expired. Click the button again for a new one." : d.reason === "used" ? "This link was already used." : "This link isn't valid.";
    return wantsHtml(c) ? c.html(page("Link", `<p>${esc(msg)}</p>`), 410) : c.json({ error: msg, reason: d.reason }, 410);
  }
  const csrf = linkCsrf(c, token);
  if (wantsHtml(c)) {
    return c.html(
      page(
        "Link your account",
        `<h1>Link your account</h1><p>${esc(d.surface_identity)} → ${esc(d.community_identity)}</p>
<p>Linking does not approve or reject anything. You'll click the button again afterwards.</p>
<form method="post"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Link these accounts</button></form>`,
      ),
    );
  }
  return c.json({ surface_identity: d.surface_identity, community_identity: d.community_identity, csrf });
});

linkPageRoutes.post("/:token", async (c) => {
  const token = c.req.param("token");
  if (!credentialMayContribute(c)) {
    return c.json({ error: "Sign in with your own account (not an API key scoped to a nest or read-only) to link." }, 403);
  }
  const ct = c.req.header("Content-Type") || "";
  const presented = ct.includes("application/json") ? (await readBody(c)).csrf : (await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)).csrf;
  if (!csrfOk(c, token, presented)) return c.json({ error: "This form expired. Open the link again." }, 403);
  const r = await redeemLinkToken({ token, userId: c.get("userId") });
  const status = r.ok ? 200 : r.reason === "mismatch" || r.reason === "already_linked" ? 409 : 410;
  if (wantsHtml(c)) return c.html(page("Link", `<p>${esc(r.message)}</p>`), status as any);
  return c.json(r.ok ? { linked: true, executed: false, message: r.message } : { linked: false, reason: r.reason, message: r.message }, status as any);
});
