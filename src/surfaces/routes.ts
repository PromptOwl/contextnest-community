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
import { config } from "../config.js";
import { hostedEnabled } from "./adapters/slack/routes.js";
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
import { createBindingWithListener } from "./services/listener-service.js";

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
      // po-1186 CR3: what the setup wizard words and offers. The org name is
      // the one the public member page shows; hosted = one-click install on.
      org_name: config.SURFACES_ORG_NAME ?? null,
      slack_hosted: hostedEnabled(),
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
    return c.json(await createBindingWithListener(bindInput(c, await readBody(c))), 201);
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
    // AC-BOOT-04: refused while the booting member is still there without
    // consent — send them the one-tap "Allow Nest back" prompt.
    if (err instanceof AppError && err.statusCode === 409 && /hasn't agreed/.test(err.message)) {
      const { askBooterConsent: ask } = await import("./services/boot-consent.js");
      const sent = await ask(c.req.param("id")).catch(() => false);
      return c.json(
        {
          error: sent
            ? `${err.message} They've been sent a one-tap "Allow Nest back" prompt.`
            : `${err.message} Nest couldn't send them the "Allow Nest back" prompt (check that the app has the im:write scope), so ask them directly.`,
          consent_prompt: sent ? "sent" : "failed",
        },
        409,
      );
    }
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
  // The one-time token is in the URL: keep it out of caches and Referer.
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
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

// ─── S2a: Slack install routes, settings, verdict log ──────────────────────

import { slackAdminRoutes } from "./adapters/slack/routes.js";
import { getSettings } from "./services/settings-service.js";
import { SettingsError } from "./core/settings.js";
import { listWindows } from "./services/report-service.js";

surfacesRoutes.route("/slack", slackAdminRoutes);

surfacesRoutes.get("/settings", async (c) => {
  try {
    if (!(await isOrgAdmin(c.get("userId")))) throw new ForbiddenError("Administrators only.");
    return c.json({ settings: await getSettings() });
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.patch("/settings", async (c) => {
  try {
    assertPersonCredential(c);
    if (!(await isOrgAdmin(c.get("userId")))) throw new ForbiddenError("Administrators only.");
    return c.json({ settings: await updateSettingsWithEffects(await readBody(c), c.get("userId")) });
  } catch (err) {
    if (err instanceof SettingsError) return c.json({ error: err.message }, 422);
    return handleError(c, err);
  }
});

/** The verdict log: windows with verdicts and counts — never text. */
surfacesRoutes.get("/windows", async (c) => {
  try {
    const scope = c.get("nestScope");
    return c.json({
      windows: await listWindows(c.get("userId"), {
        bindingId: c.req.query("binding_id") || undefined,
        verdict: c.req.query("verdict") || undefined,
        from: c.req.query("from") || undefined,
        to: c.req.query("to") || undefined,
        nestId: scope ?? undefined,
      }),
    });
  } catch (err) {
    return handleError(c, err);
  }
});

// ─── S2b: proposals, My pending, the commit audit, budgets, disconnect, drafts ─

import { listCommits, listProposals } from "./services/report-service.js";
import { myPending } from "./services/home-service.js";
import { budgetView, getBudget, setCap } from "./services/spend-service.js";
import { disconnectInstall } from "./services/lifecycle-service.js";
import { updateSettingsWithEffects } from "./services/dm-service.js";
import { getInstall } from "./services/install-store.js";
import { draftPage } from "./services/draft-page.js";
import { getDb } from "../db/client.js";

/** Proposals and outcomes (N1-redacted; admins / nest admins). */
surfacesRoutes.get("/proposals", async (c) => {
  try {
    const scope = c.get("nestScope");
    const nestId = c.req.query("nest_id") || scope || undefined;
    if (nestId) assertScope(c, nestId);
    return c.json({ proposals: await listProposals(c.get("userId"), { nestId, state: c.req.query("state") || undefined }) });
  } catch (err) {
    return handleError(c, err);
  }
});

/** The caller's My pending: only nests they read and review. */
surfacesRoutes.get("/pending", async (c) => {
  try {
    return c.json(await myPending(c.get("userId"), { nestId: c.get("nestScope") ?? null }));
  } catch (err) {
    return handleError(c, err);
  }
});

/** The commit audit (AC-SRF-01). */
surfacesRoutes.get("/commits", async (c) => {
  try {
    const scope = c.get("nestScope");
    const nestId = c.req.query("nest_id") || scope || undefined;
    if (nestId) assertScope(c, nestId);
    return c.json({
      commits: await listCommits(c.get("userId"), { nestId, nodeId: c.req.query("node_id") || undefined, proposalId: c.req.query("proposal_id") || undefined }),
    });
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.get("/nests/:nestId/budget", async (c) => {
  try {
    const nestId = c.req.param("nestId");
    assertScope(c, nestId);
    if (!(await canAdministerNest(nestId, c.get("userId")))) throw new ForbiddenError("Only an owner or admin of this nest can see its budget.");
    return c.json({ budget: budgetView(await getBudget(nestId)) });
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.patch("/nests/:nestId/budget", async (c) => {
  try {
    const nestId = c.req.param("nestId");
    assertScope(c, nestId);
    if (!(await canAdministerNest(nestId, c.get("userId")))) throw new ForbiddenError("Only an owner or admin of this nest can change its budget.");
    return c.json({ budget: await setCap(nestId, (await readBody(c)).cap_micros) });
  } catch (err) {
    if (err instanceof SettingsError) return c.json({ error: err.message }, 422);
    return handleError(c, err);
  }
});

/** Admin disconnect (§4.16 order). */
surfacesRoutes.delete("/installs/:id", async (c) => {
  try {
    assertPersonCredential(c);
    if (!(await isOrgAdmin(c.get("userId")))) throw new ForbiddenError("Only a server administrator can disconnect a workspace.");
    const i = await getInstall(c.req.param("id"));
    if (!i) throw new NotFoundError("Install not found");
    const out = await disconnectInstall(i.id);
    return c.json({ disconnected: true, withdrawn: out.withdrawn, kept: ["approved nodes", "surface_commits", "audit history"] });
  } catch (err) {
    return handleError(c, err);
  }
});

/** "/nest invite" twin: a member of the conversation brings Nest back after a member removed it. */
surfacesRoutes.post("/bindings/:id/invite", async (c) => {
  try {
    // People only (re-review INFO): resuming listening is a person's act.
    if (!credentialMayContribute(c)) throw new ForbiddenError("Inviting Nest back needs your own full credential, not an agent or scoped key.");
    const row = await scopedRow(c, c.req.param("id"));
    const { inviteBackAsUser } = await import("./services/invite-service.js");
    const out = await inviteBackAsUser(row.id, c.get("userId"));
    // Re-review N2: a non-admin learns only the outcome — no booter, name or guard counts.
    const full = await canAdministerNest(row.nest_id, c.get("userId"));
    const fresh = full ? await getBindingRow(row.id) : null;
    if (!out.ok) {
      return c.json({ error: out.message, reason: out.reason, ...(fresh ? { binding: await bindingView(fresh) } : {}) }, out.reason === "not_found" ? 404 : out.reason === "not_member" ? 403 : 409);
    }
    return c.json({ status: out.status, message: out.message, ...(fresh ? { binding: await bindingView(fresh) } : {}) });
  } catch (err) {
    return handleError(c, err);
  }
});

/** The full draft behind a card: readers of the nest only, never indexed (AC-CRD-04). */
surfacesRoutes.get("/drafts/:itemId", async (c) => {
  try {
    // Security L1: a nest-scoped key only reaches drafts of its own nest.
    const it = (await getDb().get("SELECT nest_id FROM surface_proposal_items WHERE id = ?", [c.req.param("itemId")])) as { nest_id: string } | undefined;
    if (!it) throw new NotFoundError("Not found");
    const scope = c.get("nestScope");
    if (scope && scope !== it.nest_id) throw new NotFoundError("Not found");
    assertScope(c, it.nest_id);
    const out = await draftPage(c.req.param("itemId"), c.get("userId"));
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Cache-Control", "private, no-store");
    if (out.status !== 200) return c.json({ error: out.error }, out.status as any);
    return c.html(out.html);
  } catch (err) {
    return handleError(c, err);
  }
});

/**
 * Sealed personal nests a server admin may know about (Misha, 2026-11-01):
 * existence, owner, size and created date — never titles or content.
 */
surfacesRoutes.get("/sealed-nests", async (c) => {
  try {
    assertPersonCredential(c);
    if (!(await isOrgAdmin(c.get("userId")))) throw new ForbiddenError("Administrators only.");
    const rows = (await getDb().all(
      `SELECT p.nest_id, p.community_user_id, u.email, u.name, n.created_at,
              (SELECT COUNT(*) FROM node_index ni WHERE ni.nest_id = p.nest_id) AS documents
         FROM surface_personal_nests p JOIN nests n ON n.id = p.nest_id LEFT JOIN users u ON u.id = p.community_user_id
        WHERE p.sealed = 1 ORDER BY n.created_at`,
    )) as Array<{ nest_id: string; community_user_id: string; email: string | null; name: string | null; created_at: string; documents: number | string }>;
    return c.json({
      nests: rows.map((r) => ({
        nest_id: r.nest_id,
        owner: { user_id: r.community_user_id, email: r.email, name: r.name },
        documents: Number(r.documents),
        created_at: r.created_at,
        sealed: true,
      })),
    });
  } catch (err) {
    return handleError(c, err);
  }
});

// ─── S3: seeds (PRD §13, AC-SEED-10) ────────────────────────────────────────
//
// POST /surfaces/seeds/apply {nest_id, seed_id, library_nest_id?, upgrade?, dry_run?}
// GET  /surfaces/seeds?nest_id=            seeds the caller may apply to N
// GET  /surfaces/seeds/status?nest_id=     what N has applied
// Nest admins only, on a person's own full credential (read-only keys are
// refused by the middleware above, nest-scoped keys never reach /surfaces).
// The MCP twins call the same service functions.

import { applySeed, listSeedsForNest, seedStatus } from "./services/seed-service.js";

surfacesRoutes.post("/seeds/apply", async (c) => {
  try {
    assertPersonCredential(c);
    const b = await readBody(c);
    const nestId = str(b.nest_id, "nest_id")!;
    assertScope(c, nestId);
    const out = await applySeed({
      nestId,
      seedId: str(b.seed_id, "seed_id")!,
      libraryNestId: str(b.library_nest_id, "library_nest_id", false) ?? null,
      upgrade: bool(b.upgrade, "upgrade") ?? false,
      dryRun: bool(b.dry_run, "dry_run") ?? false,
      actorUserId: c.get("userId"),
      // S7-R2 M1: a key's writes honour the nest's push-confirmation gate.
      credential: { keyId: c.get("apiKeyId") ?? null, agentSurface: false },
    });
    return c.json(out);
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.get("/seeds", async (c) => {
  try {
    const nestId = str(c.req.query("nest_id"), "nest_id")!;
    assertScope(c, nestId);
    return c.json({ seeds: await listSeedsForNest(nestId, c.get("userId")) });
  } catch (err) {
    return handleError(c, err);
  }
});

surfacesRoutes.get("/seeds/status", async (c) => {
  try {
    const nestId = str(c.req.query("nest_id"), "nest_id")!;
    assertScope(c, nestId);
    return c.json(await seedStatus(nestId, c.get("userId")));
  } catch (err) {
    return handleError(c, err);
  }
});
