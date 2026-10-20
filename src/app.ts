import { Hono } from "hono";
import type { Context } from "hono";
import { getSessionIdFromRequest } from "./auth/sessions.js";
import { LinearRouter } from "hono/router/linear-router";
import { createMiddleware } from "hono/factory";
import { cors } from "hono/cors";
import { mergeFrameAncestors } from "./shared/artifact-sandbox.js";
import { authRoutes } from "./auth/routes.js";
import { nestRoutes } from "./nests/routes.js";
import { sharingRoutes } from "./nests/sharing-routes.js";
import { boardRoutes } from "./nests/board-routes.js";
import { fieldRoutes } from "./nests/field-routes.js";
import { pinRoutes } from "./nests/pin-routes.js";
import { listAssignedTo } from "./nodes/assigned-service.js";
import { headlessRoutes } from "./nests/headless-routes.js";
import { countPeople } from "./auth/headless.js";
import { brandingRoutes } from "./nests/branding-routes.js";
import { grantRoutes } from "./nests/grant-routes.js";
import { publishRoutes } from "./nests/publish-routes.js";
import { publishRenderRoutes } from "./nests/publish-render-routes.js";
import { nestTeamRoutes } from "./nests/nest-team-routes.js";
import { peopleRoutes } from "./nests/people-routes.js";
import { teamRoutes } from "./governance/team-routes.js";
import { listVisibleNests, nestAllowsSelfApprove } from "./nests/service.js";
import {
  getReviewQueue,
  listDeletionRequests,
} from "./governance/review-service.js";
import { listMyDrafts } from "./governance/version-service.js";
import { folderForNode } from "./governance/title-resolver.js";
import { engineCache } from "./nodes/engine.js";
import {
  matchDocuments,
  toSearchHit,
  discoverForSearch,
  titleScore,
} from "./nodes/search.js";
import { resolveCallerEmail, filterAccessible } from "./governance/access-guard.js";
import {
  resolveStewardsForNode,
  canManageStewards,
  resolveUserRoles,
} from "./governance/stewardship-service.js";
import { resolveNodeGrant } from "./governance/grants-service.js";
import { nodeRoutes } from "./nodes/routes.js";
import { annotationRoutes } from "./annotations/routes.js";
import { queryRoutes } from "./nodes/query-routes.js";
import { pushRoutes } from "./nests/push-routes.js";
import { hootieRoutes } from "./hootie/routes.js";
import { verifyModelKey } from "./hootie/model.js";
import {
  HOOTIE_BRAND_FIELDS,
  changedHootieBrandFields,
  effectiveHootieBrand,
  hootieBrandingAvailable,
  storedHootieSettings,
  validateHootieBrandFields,
} from "./hootie/brand.js";
import { mcpRoutes } from "./mcp/routes.js";
import { edgeTypeRoutes } from "./workflow/edge-type-routes.js";
import { edgeRoutes } from "./workflow/edge-routes.js";
import {
  runTriggerRoutes,
  runListRoutes,
  runDetailRoutes,
} from "./workflow/run-routes.js";
import { scheduleRoutes } from "./workflow/schedule-routes.js";
import { metacognitionRoutes } from "./metacognition/routes.js";
import { envRoutes } from "./workflow/env-routes.js";
import { connectorRoutes } from "./notify/connector-routes.js";
import { messageLogRoutes } from "./notify/message-log-routes.js";
import { sendTestNotification } from "./notify/dispatch.js";
import { hookNestRoutes, hookFireRoutes } from "./workflow/hook-routes.js";
import {
  listNotifications,
  markNotificationsRead,
} from "./governance/notify-service.js";
import { definitionRoutes } from "./definitions/routes.js";
import { structureRoutes } from "./structure/routes.js";
import { ContextNestError } from "@promptowl/contextnest-engine";
import { forPeople } from "./structure/writes.js";
import { isDerivedAnnotationsNode, ACCEPTED_NODE_TYPES } from "./nodes/service.js";
import { assetRoutes, ASSET_MAX_REQUEST_BYTES } from "./nests/asset-routes.js";
import {
  pdfNodeRoutes,
  PDF_UPLOAD_PATH,
  pdfMaxRequestBytes,
  pdfTooLargeMessage,
} from "./nodes/pdf-routes.js";
import { logTraceEvent, listTraceEvents } from "./telemetry/trace-log.js";
import { flushAccessLog } from "./governance/access-log.js";
import {
  ACTIVITY_TYPES,
  getScopedActivity,
  normalizeFolder,
  type ActivityType,
} from "./governance/scoped-activity-service.js";
import {
  isSuperAdmin,
  isConfigSuperAdmin,
  getAccessConfig,
  loadGrantedSuperAdmins,
} from "./governance/access-service.js";
import { communitySiteRoutes } from "./auth/community-sites-routes.js";
import { ssoCandidates } from "./auth/community-sites.js";
import {
  llmsTxtRoutes,
  nestIndexRoutes,
  serverMcpRoutes,
} from "./mcp/server-routes.js";
import { governanceRoutes, governanceNodeRoutes } from "./governance/routes.js";
import { accessRequestRoutes } from "./governance/access-request-routes.js";
import {
  accessRequestHint,
  canDecideAccessRequests,
  listAccessRequests,
  writeTargetForPath,
} from "./governance/access-request-service.js";
import { authMiddleware, type AuthEnv } from "./auth/middleware.js";
import { nestScopedKeyGuard } from "./auth/nest-scope-guard.js";
import { isValidTicketSub } from "./auth/sso-token.js";
import { resolveMcpTicketUser, mcpTicketSecrets } from "./auth/mcp-ticket.js";
import { systemRoutes, nestSystemRoutes } from "./auth/system-routes.js";
import { assertSafeNodeId } from "./shared/node-id.js";
import {
  resolveNestPermission,
  resolveNestAccess,
  isNestArchived,
  permissionLevel,
  isServerAdminUserId,
  type NestPermission,
} from "./shared/access.js";
import {
  AppError,
  ValidationError,
  VaultBusyError,
  PlanLimitError,
  isVaultLockTimeout,
} from "./shared/errors.js";
import { config, isEmailish, isEmailListish } from "./config.js";
import {
  verifyEmailTransport,
  isEmailConfigured,
  transportSettings,
} from "./notify/email.js";
import { getDb } from "./db/client.js";
import { ensureAnonymousUser } from "./auth/anonymous.js";
import {
  isSuspended,
  getSuspensionReason,
  getOfflineLock,
  getCurrentLicense,
  installLicenseKey,
  getLastLicenseCheck,
  getLicenseOwnerEmail,
  getPendingRejections,
  getEntitlement,
  getOwnGateway,
  setOwnProviderKey,
  validateLicense,
  OWN_KEY_PROVIDERS,
  DEFAULT_LICENSE_CONTACT,
  type LicenseInfo,
} from "./auth/license.js";
import { countBilled, assertCanGrant, assertCanAddAccountOwner, planLimitMessage } from "./auth/seats.js";
import { hasEntitlement } from "./auth/entitlements.js";
import {
  resolveModelCredential,
  hootieModel,
  listCredentialModels,
  bareModelName,
  modelProvider,
} from "./shared/model-credential.js";
import { NEUTRAL_READ_ONLY, canSeeLicenseDetail, offlineLockMessage } from "./auth/license-copy.js";
import { tryConsume } from "./shared/rate-limit.js";
import { clientIp } from "./shared/request-ip.js";
import { FREE_TIER_EXCEEDED_MESSAGE, withinFreeTier, writesAllowed } from "./auth/free-tier.js";
import { SERVICE_VERSION } from "./shared/version.js";
import { persistSetting } from "./db/settings.js";
import { posthogKeyError } from "./shared/posthog-key.js";
import { publicBaseUrlError } from "./shared/public-base-url.js";
import {
  protectedResourceMetadata,
  authorizationServerMetadata,
  mcpChallenge,
} from "./auth/oauth-metadata.js";
import { oauthRoutes } from "./auth/oauth-routes.js";
import { resolveAccessToken } from "./auth/oauth-store.js";
import { isEnterpriseIssuer, isOidcReady } from "./auth/oidc.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { existsSync } from "node:fs";

// Resolve UI static files. In built mode this file lives at dist/index.js,
// so siblings of __dirname include dist/web3. In dev (`tsx src/index.ts`)
// __dirname is src/, which has no web3 — fall back to <cwd>/dist/web3
// (vite build output) so `npm run dev` serves the freshly-built bundle.
// serveStatic wants a path relative to CWD.
const HERE = dirname(fileURLToPath(import.meta.url));

const UI_DIR_CANDIDATES = [
  join(HERE, "web3"),
  join(process.cwd(), "dist", "web3"),
];
const UI_DIR_ABS =
  UI_DIR_CANDIDATES.find((p) => existsSync(p)) || UI_DIR_CANDIDATES[0];
const UI_DIR_REL = relative(process.cwd(), UI_DIR_ABS) || ".";

/** Whole days until an ISO date (negative once past); null = no date. */
function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  return isNaN(ms) ? null : Math.ceil(ms / 86_400_000);
}

/** License-term fields shared by /license/status, /admin/license and a
 *  rejected install: what the license is, when it ends, why PromptOwl last
 *  refused it, and who to talk to. */
function licenseTerms(lic: LicenseInfo | null | undefined) {
  return {
    trial: !!lic?.trial,
    expires_at: lic?.expiresAt ?? null,
    days_left: daysUntil(lic?.expiresAt),
    reason: lic?.reason ?? null,
    grace_ends_at: lic?.graceEndsAt ?? null,
    contact: lic?.contact ?? DEFAULT_LICENSE_CONTACT,
  };
}

/** Operator-facing message for a key PromptOwl refused at install time. */
function rejectedKeyMessage(info: LicenseInfo): string {
  const contact = info.contact ?? DEFAULT_LICENSE_CONTACT;
  const talk = `Talk to PromptOwl (${contact.url} or ${contact.email}) to renew or get a new key.`;
  switch (info.reason) {
    case "expired": {
      const when = info.expiresAt
        ? ` on ${new Date(info.expiresAt).toDateString()}`
        : "";
      return `This ${info.trial ? "trial" : "license"} ended${when}, so the key wasn't saved. ${talk}`;
    }
    case "deactivated":
      return `This license key has been deactivated, so it wasn't saved. ${talk}`;
    case "suspended":
      return `This license is suspended, so it wasn't saved. ${talk}`;
    default:
      return "PromptOwl rejected this license key. It wasn't saved. Verify the key is correct and active, then try again.";
  }
}
// True for a browser loading this URL as a page (hard reload, typed/bookmarked
// link), false for the app's own fetch()es and other programmatic callers.
// Sec-Fetch-Mode is sent by every current browser on navigation; the Accept
// sniff is the fallback for older ones. Non-browser clients send neither (the
// MCP SDK's discovery fetch sets no Accept header at all), and this app's own
// API client (ui/src/lib/api.ts) never sets an HTML Accept either.
const isDocumentNavigation = (c: { req: { header(n: string): string | undefined } }) =>
  c.req.header("Sec-Fetch-Mode") === "navigate" ||
  (c.req.header("Accept") || "").includes("text/html");

// The SPA shell, shared by the catch-all below and the /teams guard — same
// file, same no-cache policy (index.html is unhashed and must always
// revalidate so a deploy's new bundle is picked up on next load).
const serveIndexShell = serveStatic({
  root: UI_DIR_REL,
  path: "index.html",
  onFound: (_p, c) => c.header("Cache-Control", "no-cache"),
});

// In open mode, assign the anonymous admin user to every request.
// This gives full access without requiring auth headers.
const openModeMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const anonId = await ensureAnonymousUser();
  c.set("userId", anonId);
  c.set("nestScope", null);
  c.set("keyCapability", "write");
  await next();
});

/** Nest surfaces a named system key (CU-wdqcq0538g) never reaches, whatever
 *  its collaborator standing: people, sharing, settings, publishing,
 *  credentials and automation wiring. A system syncs content; it doesn't
 *  administer the nest (and can't confirm its own held pushes). */
const SYSTEM_DENIED_RESOURCES = new Set([
  "collaborators",
  "teams",
  "visibility",
  "settings",
  "reader-mode",
  "grants",
  "systems",
  "headless",
  "publications",
  "branding",
  "metacognition",
  "schedules",
  "hooks",
  "env",
  "connectors",
  "trace",
  "stewards",
  "archive",
  "restore",
  "push-allowlist",
  "pending-pushes",
]);

// Unauth GETs in key mode: allow read-only access to a specific nest
// (/nests/:id and its sub-routes) so public nests work without login.
// The bare /nests list is excluded — anon callers must not discover the
// nest inventory. Admin paths and writes still 401.
function isPublicReadEligiblePath(method: string, path: string): boolean {
  if (method !== "GET") return false;
  if (!/^\/nests\/[^/]+(\/.*)?$/.test(path)) return false;
  // The nest steward roster (/nests/:id/stewards) is admin-gated, never
  // public — keep it behind real auth. Without this, an anonymous caller on
  // an anon-owned nest (nests.user_id === ANON_USER_ID, e.g. created under a
  // previous AUTH_MODE=open run) is treated as the anon owner, so the
  // roster gate below resolves "owner" and leaks emails/roles. The
  // node-level resolve (/nests/:id/nodes/:nid/stewards) stays public so the
  // editor UI can still resolve a caller's per-node role.
  if (/^\/nests\/[^/]+\/stewards/.test(path)) return false;
  return !/\/(collaborators|visibility|settings|mcp)/.test(path);
}

/**
 * Presence of a session cookie, not its value. Kept in one place so the two
 * middlewares that ask cannot drift; extracting the id is
 * getSessionIdFromRequest's job.
 */
function hasSessionCookie(c: Context<AuthEnv>): boolean {
  return !!getSessionIdFromRequest(c);
}

/**
 * The OAuth challenge on /mcp. Runs ahead of every other auth path.
 *
 * An MCP client's first request carries no credential on purpose: it expects a
 * 401 whose WWW-Authenticate header points at the protected-resource metadata,
 * and that is the ONLY thing that starts the authorization flow. Claude does
 * not honour the header on a 200 and treats a tool-level error as a tool
 * error, so the status and the header have to be exactly this.
 *
 * Deliberately narrow:
 * - Only when a credential is entirely absent. A stale OAuth access token is
 *   answered by mcpOAuthBearer with `error="invalid_token"`, which tells the
 *   client to refresh or re-authorize; other bad credentials get the
 *   ordinary rejection.
 * - Never in open mode, where there is no credential to ask for.
 * - Never while MCP_OAUTH_ENABLED is off, so the flag-off behaviour of this
 *   endpoint is byte-identical to before.
 */
const mcpOAuthChallenge = createMiddleware<AuthEnv>(async (c, next) => {
  if (!config.MCP_OAUTH_ENABLED || config.AUTH_MODE === "open")
    return next();
  if (!config.PUBLIC_BASE_URL) return next();
  const hasAuth = !!c.req.header("Authorization");
  if (hasAuth || hasSessionCookie(c)) return next();
  c.header("WWW-Authenticate", mcpChallenge(config.PUBLIC_BASE_URL));
  return c.json(
    {
      error: "Authentication required — authorize this client to continue.",
      code: "missing_credentials",
    },
    401,
  );
});

/**
 * Accept an access token this server issued, and resolve it to its user.
 *
 * Runs after the challenge and before the ticket path. A credential that is
 * not 64 hex is passed through untouched, so `cnst_` keys and MCP tickets keep
 * working exactly as before. A 64-hex token that does not resolve is one of
 * ours gone stale, and gets a 401 with `error="invalid_token"`.
 *
 * The user id set here is what `buildNestIndex` gates on, which is the whole
 * point: the caller now arrives as a person rather than as whoever owns a
 * pasted key.
 */
const mcpOAuthBearer = createMiddleware<AuthEnv>(async (c, next) => {
  const fallThrough = () => flexAuthWithPromptowlTicket(c, next);
  if (!config.MCP_OAUTH_ENABLED) return fallThrough();
  const header = c.req.header("Authorization") || "";
  if (!header.startsWith("Bearer ")) return fallThrough();
  const token = header.slice("Bearer ".length);
  // Our access tokens are 64 hex chars and share no prefix with cnst_ keys or
  // the dotted JWT tickets, so this check costs one lookup at most.
  if (!/^[0-9a-f]{64}$/.test(token)) return fallThrough();

  const grant = await resolveAccessToken(token);
  // Expired, revoked, or its user removed. Nothing else is 64 hex, so this is
  // a stale token of ours: answer with the challenge so the client refreshes
  // or re-authorizes (MCP authorization spec; RFC 6750 §3.1).
  if (!grant) {
    if (config.PUBLIC_BASE_URL)
      c.header("WWW-Authenticate", mcpChallenge(config.PUBLIC_BASE_URL, "invalid_token"));
    return c.json(
      { error: "This connection has expired or was revoked — reconnect to continue.", code: "invalid_token" },
      401,
    );
  }

  c.set("userId", grant.userId);
  // OAuth grants are never narrowed to one nest: the whole point is that one
  // connection reads across everything the person can see.
  c.set("nestScope", null);
  // OAuth grants are narrowed by oauthScope at tool dispatch, not by a key
  // capability: the credential itself is the person's (full tier).
  c.set("keyCapability", "write");
  // What the person actually consented to. Enforced at tool dispatch — a
  // consent screen that says "read" while write tools still work is a lie.
  c.set("oauthScope", grant.scope.split(" ").filter(Boolean));
  return next();
});

const flexAuthMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const hasBearer = c.req.header("Authorization")?.startsWith("Bearer cnst_");
  if (hasBearer || hasSessionCookie(c)) {
    return authMiddleware(c, next);
  }

  if (config.AUTH_MODE === "open") {
    const anonId = await ensureAnonymousUser();
    c.set("userId", anonId);
    c.set("nestScope", null);
    c.set("keyCapability", "write");
    return next();
  }

  if (isPublicReadEligiblePath(c.req.method, c.req.path)) {
    const anonId = await ensureAnonymousUser();
    c.set("userId", anonId);
    c.set("nestScope", null);
    c.set("keyCapability", "write");
    return next();
  }

  // Same shape as authMiddleware's own missing_credentials fallback (below) —
  // this is the far more common path there: no Authorization header and no
  // session cookie at all, vs. authMiddleware's narrower "had a cnst_-shaped
  // credential that didn't validate" case.
  return c.json(
    { error: "Authentication required — sign in or provide an API key.", code: "missing_credentials" },
    401,
  );
});

// MCP bearer tickets — /index and /mcp additionally accept a short-lived HS256
// service ticket, minted either by the official PromptOwl deployment (the
// shared OFFICIAL_COMMUNITY_SSO_SECRET the /auth/sso login flow trusts) or by
// this server's own SSO token-exchange (MCP_SIGNING_SECRET). Either secret
// verifies — see the constant-time loop below. Distinctions from a login ticket: `scope: "mcp"` is
// REQUIRED here (a leaked one-time SSO login ticket can't double as a bearer
// credential) and there's no jti (this ticket can't be redeemed for a login
// session). The user is resolved by email and must ALREADY exist — native
// access never auto-provisions; PromptOwl relies on that to only auto-connect
// users who hold accounts on both sides. Non-JWT bearers (cnst_ keys),
// cookies, and open mode fall through to flexAuthMiddleware unchanged.
/** Path segments under /nests, e.g. "/nests/abc/mcp" → ["abc", "mcp"]. Shared
 *  by the ticket-eligibility gate and the access-control gate so their view of
 *  the route can't silently drift (the ticket allowlist must always describe
 *  the same paths the access boundary enforces). */
function nestPathParts(path: string): string[] {
  return path.replace(/^\/nests\//, "").split("/").filter(Boolean);
}

const flexAuthWithPromptowlTicket = createMiddleware<AuthEnv>(
  async (c, next) => {
    const header = c.req.header("Authorization") || "";
    const token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    // An MCP bearer may be signed by PromptOwl (the shared official secret) OR,
    // on a self-hosted deployment, by this server's own MCP_SIGNING_SECRET (the
    // key the SSO token-exchange mints with). Accept a ticket that verifies
    // under EITHER — each attempt is an independent constant-time HMAC check,
    // and a ticket matching neither is rejected. Order is irrelevant: a forged
    // token fails both; a genuine one matches exactly the secret that signed it.
    const secrets = mcpTicketSecrets();
    const looksLikeJwt =
      !!token && !token.startsWith("cnst_") && token.split(".").length === 3;
    if (!looksLikeJwt || secrets.length === 0) {
      return flexAuthMiddleware(c, next);
    }

    // Verification (either secret, expiry code, scope:"mcp", no jti,
    // audience, existing person) lives in auth/mcp-ticket.ts, shared with
    // POST /auth/keys/exchange so the two ticket consumers can't drift.
    const resolved = await resolveMcpTicketUser(token, secrets);
    if (!resolved.ok) {
      return c.json(
        resolved.code ? { error: resolved.error, code: resolved.code } : { error: resolved.error },
        resolved.status,
      );
    }
    const { claims, sub } = resolved;

    c.set("userId", resolved.userId);
    c.set("nestScope", null);
    // PromptOwl service tickets act as the full user (never read-only).
    c.set("keyCapability", "write");
    // Shared agent driven by someone else: label held pushes with who asked.
    const act = typeof claims.act === "string" ? claims.act.trim() : "";
    if (isValidTicketSub(act) && act.toLowerCase() !== sub.toLowerCase()) {
      c.set("apiKeyLabel", `${act} via ${sub}'s agent`);
    }
    return next();
  },
);

// Short-TTL cache for the /me/work approve-capability check. The dashboard
// polls this inbox, and a caller's nest roles change rarely — so caching the
// per-(nest, user) "can approve here?" boolean for a few seconds skips the
// repeated resolveUserRoles round-trips on each poll, without holding stale
// governance long enough to matter. Global map (single-process server).
const APPROVE_CACHE_TTL_MS = 30_000;
const approveCache = new Map<string, { ok: boolean; exp: number }>();
async function canApproveInNest(nestId: string, email: string): Promise<boolean> {
  const key = `${nestId} ${email.toLowerCase()}`;
  const now = Date.now();
  const hit = approveCache.get(key);
  if (hit && hit.exp > now) return hit.ok;
  // MUST mirror canUserApprove's nest-level gate, not the pure canApproveWith:
  // admin/reviewer approve always, but a BARE owner (no admin/reviewer steward
  // role) can only approve when the nest allows self-approve. Using
  // canApproveWith here — which treats "owner" as always approve-capable — put
  // a dead Approve button back in front of owners who delegated approval to a
  // reviewer and left self-approve off (the default SoD setup). Fetch the flag
  // only for the owner-only case so reviewers/admins skip the extra read.
  const roles = await resolveUserRoles(nestId, email);
  let ok = roles.includes("admin") || roles.includes("reviewer");
  if (!ok && roles.includes("owner")) ok = await nestAllowsSelfApprove(nestId);
  // Cheap bound: sweep expired entries when the map grows, so a long-running
  // server polling /me/work across many (nest, user) pairs doesn't accumulate
  // stale keys forever. O(n) but only past a threshold, amortized to nothing.
  if (approveCache.size > 500) {
    for (const [k, v] of approveCache) if (v.exp <= now) approveCache.delete(k);
  }
  approveCache.set(key, { ok, exp: now + APPROVE_CACHE_TTL_MS });
  return ok;
}

export function createApp(): Hono<AuthEnv> {
  // LinearRouter, not the default SmartRouter — parity with upstream
  // development (bb96ca8), which hit the same bug class this branch fixed
  // structurally: greedy `/:nodeId{.+}` params vs suffix routes. SmartRouter
  // picks RegExpRouter (catch-all shadows suffix routes) or, when any route
  // pattern is unsupported, silently falls back to TrieRouter (suffix routes
  // dead for ids nested 3+ segments). LinearRouter matches in registration
  // order with per-route backtracking, so mount order = specificity order and
  // both failure modes disappear. Route count is small; the scan is cheap.
  const app = new Hono<AuthEnv>({ router: new LinearRouter() });

  // Hono request logger disabled — keep terminal clean. Re-enable by
  // restoring `app.use("*", logger())` if request tracing is needed.
  // CORS allowlist — see config.CORS_ORIGINS. In key mode we default to a
  // locked-down localhost-only list and set credentials:true so Bearer
  // tokens work. In open mode there are no credentials to exfiltrate, so
  // "*" is acceptable.
  const corsOrigins = config.CORS_ORIGINS;
  app.use(
    "*",
    corsOrigins === "*"
      ? cors({ origin: "*" })
      : cors({ origin: corsOrigins, credentials: true }),
  );

  // Clickjacking guard — only the origins in config.FRAME_ANCESTORS may frame
  // this server. CORS does not cover this: it governs who may *read* our
  // responses, not who may *embed* us, so without this any site could iframe
  // the UI invisibly and harvest a signed-in operator's clicks.
  //
  // Appended rather than assigned, because artifact responses already ship
  // their own strict CSP (see shared/artifact-sandbox.ts) — overwriting it
  // would drop the sandbox that keeps attacker-authored artifact HTML off the
  // session. Skipped entirely when a handler set frame-ancestors itself.
  const frameAncestors = `frame-ancestors ${config.FRAME_ANCESTORS}`;
  app.use("*", async (c, next) => {
    await next();
    const existing = c.res.headers.get("Content-Security-Policy");
    const merged = mergeFrameAncestors(existing, frameAncestors);
    if (merged !== existing) c.header("Content-Security-Policy", merged);
  });

  // Request body size cap — prevents DoS via giant POST payloads before
  // a handler ever gets to parse JSON. Only applies when Content-Length
  // is declared; streamed bodies fall through (uncommon on this API).
  // The asset-upload route gets a higher ceiling (video uploads, per-type
  // caps enforced in the handler), and so does the PDF upload route (up to
  // PDF_MAX_MB, enforced again in its handler) — the global cap is untouched.
  const ASSET_UPLOAD_PATH = /^\/nests\/[^/]+\/assets\/?$/;
  app.use("*", async (c, next) => {
    const lenStr = c.req.header("Content-Length");
    if (lenStr) {
      const len = parseInt(lenStr, 10);
      const isPost = c.req.method === "POST";
      const isPdf = isPost && PDF_UPLOAD_PATH.test(c.req.path);
      const cap =
        isPost && ASSET_UPLOAD_PATH.test(c.req.path)
          ? Math.max(config.MAX_BODY_BYTES, ASSET_MAX_REQUEST_BYTES)
          : isPdf
            ? Math.max(config.MAX_BODY_BYTES, pdfMaxRequestBytes())
            : config.MAX_BODY_BYTES;
      if (Number.isFinite(len) && len > cap) {
        return c.json(
          {
            // A PDF gets the same message as the route's own gates.
            error: isPdf
              ? pdfTooLargeMessage(len)
              : `Request body too large (${len} bytes, max ${cap})`,
          },
          413,
        );
      }
    }
    return next();
  });

  // Activity trace — one row per API request (MCP tool calls log separately
  // in mcp/routes.ts with the tool name). Registered before the routes so it
  // wraps everything; userId is read AFTER next() because the per-group auth
  // middleware sets it downstream. Static assets, the SPA shell, and /health
  // are noise, not activity — skipped.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    const traced =
      /^\/(nests|auth|admin|stats|license|index|mcp)(\/|$)/.test(path) &&
      !path.endsWith("/mcp"); // MCP transport rows come from the tool logger
    const started = Date.now();
    await next();
    if (!traced) return;
    void logTraceEvent({
      kind: "api",
      method: c.req.method,
      path,
      nestId: /^\/nests\/([^/]+)/.exec(path)?.[1] ?? null,
      userId: c.get("userId") ?? null,
      status: c.res.status,
      durationMs: Date.now() - started,
      // Set by whichever handler validated the request's `client` block
      // (§9.4). Absent on a request that sent none.
      client: c.get("clientMetadata"),
    });
  });

  // Nest-scoped API keys are deny-by-default outside their nest. Registered
  // ahead of every route (and every route's own auth) so a route added later
  // is closed to nest keys until it is allowlisted on purpose — see
  // auth/nest-scope-guard.ts for what a nest key may reach.
  app.use("*", nestScopedKeyGuard);

  // Health check (public)
  app.get("/health", (c) => {
    const oidcReady = isOidcReady();
    return c.json({
      status: isSuspended() ? "suspended" : "ok",
      service: "contextnest-community",
      version: SERVICE_VERSION,
      auth_mode: config.AUTH_MODE,
      // Lets a client know this server can run the OAuth flow before it tries.
      mcp_oauth_enabled: config.MCP_OAUTH_ENABLED,
      logo_url: config.LOGO_URL,
      // Presence only, never the value: lets the UI stop prompting for a
      // runner key once runs have a credential (own key or PromptOwl's).
      runner_key_configured: !!resolveModelCredential(),
      // Presence only: the publish dialog hides the email/invite gates when
      // this server cannot send mail, because their only way in is a mailed link.
      email_configured: isEmailConfigured(),
      // Who may create nests (admins | everyone) — the Nests page hides the
      // create buttons from non-admins when it's admins-only.
      nest_creation: config.NEST_CREATION,
      // Product analytics for the SPA. The PostHog project key is a public
      // client key, but it only ships while usage telemetry is on — one switch
      // covers everything this server sends outward.
      posthog_key: config.TELEMETRY_ENABLED ? config.POSTHOG_KEY || null : null,
      posthog_host: config.POSTHOG_HOST,
      promptowl_sign_in_gate: config.PROMPTOWL_SIGN_IN_GATE,
      // Manual (email/password) sign-in mode (open | invite-only | disabled).
      // The login page reads this to show/hide the credential form, and to
      // switch the Register link to an "activate invite" affordance.
      manual_sign_in: config.MANUAL_SIGN_IN,
      // OIDC SSO — true only when enabled AND fully configured, so the login
      // page never shows a button that would bounce with an error. The issuer
      // is exposed (when live) so the client can label the button by IdP
      // (login.microsoftonline.com → Microsoft, accounts.google.com → Google).
      oidc_enabled: oidcReady,
      ...(oidcReady && { oidc_issuer: config.OIDC_ISSUER }),
      // "Sign in with Google" via PromptOwl: the button sends the browser to
      // PromptOwl's community-sso route, which signs the user in (Google
      // creates the PromptOwl account) and returns a ticket to GET /auth/sso.
      // Live only when this server can verify that ticket.
      ...(ssoCandidates().length > 0 && {
        promptowl_google_url: `${config.PROMPTOWL_API_URL.replace(/\/$/, "")}/api/auth/community-sso?provider=google`,
      }),
      // Public feature flags the SPA needs before auth to decide what to
      // render. Mirrors the server-side route gate so UI and API agree:
      // flag off → the plane's routes 404 AND its UI stays hidden.
      workflow_plane_enabled: config.FEATURE_WORKFLOW_PLANE,
      // Import teams from PromptOwl (default OFF). Off → /teams/promptowl 404s
      // and the UI hides the PromptOwl Teams panel.
      promptowl_teams_enabled: config.PROMPTOWL_TEAMS_ENABLED,
      // Content-type toggles (default ON). The editor's type picker mirrors
      // these so a disabled type disappears from creation exactly when the
      // API would refuse it — existing nodes of the type stay readable.
      type_artifact_enabled: config.TYPE_ARTIFACT_ENABLED,
      type_table_enabled: config.TYPE_TABLE_ENABLED,
      // Project-board tasks — on once the engine knows the type (see
      // ACCEPTED_NODE_TYPES). Off → the board's "+ Add task" makes documents.
      type_task_enabled: ACCEPTED_NODE_TYPES.has("task"),
      // Hootie in the nest (default OFF — admins opt in). Off → POST
      // /nests/:id/chat 404s and the UI hides the launcher. Whether it can
      // actually answer is runner_key_configured above — the UI shows the
      // launcher whenever the feature is on and explains the missing key,
      // rather than hiding it.
      hootie_enabled: config.HOOTIE_ENABLED,
      // Metacognition agents (default OFF; needs the workflow plane too). Off →
      // /nests/:id/metacognition 404s and the Workflows view hides its tab.
      metacognition_enabled: config.FEATURE_WORKFLOW_PLANE && config.FEATURE_METACOGNITION,
      // Experimental features, one key each (default OFF; superadmin switches
      // under Settings → Features). Off → the feature's routes 404 and the UI
      // renders none of it. Add new experimental switches as keys here.
      experimental: {
        doc_pins: config.EXPERIMENTAL_DOC_PINS,
      },
      // The identity every surface shows: the admin's custom name/logo/
      // colour/greeting on an enterprise licence, the default Hootie
      // otherwise (enforced here, not in the client). Public: the launcher
      // renders before sign-in, and none of it is secret.
      hootie_brand: effectiveHootieBrand(),
      hootie_branding_available: hootieBrandingAvailable(),
      // Own model key / gateway allowed (licence feature byok, Enterprise).
      byok_available: hasEntitlement("byok"),
      // This server hosts several organizations (PromptOwl-hosted) rather than
      // one. The visibility picker words 'Organization' and 'Public' by it and
      // confirms before 'org'; the server enforces the same in
      // PATCH /nests/:id/visibility.
      shared_deployment: config.SHARED_DEPLOYMENT,
      // Sub-agent runs gate its own recursion surface separately (env-only,
      // must clear a security review — NOT a UI toggle). Exposed read-only so
      // the Runs page shows the "spawn sub-agent" option only when it's live.
      subagent_runs_enabled: config.FEATURE_SUBAGENT_RUNS,
      // Recursion bounds (env-overridable in config.ts). Exposed so the Runs
      // page validates a spawn against the SERVER's real caps instead of
      // duplicating the defaults — an operator raising/lowering these stays
      // in sync with the picker's grey-outs.
      subagent_max_depth: config.SUBAGENT_MAX_DEPTH,
      subagent_max_children: config.SUBAGENT_MAX_CHILDREN,
      ...(isSuspended() && { suspended_reason: getSuspensionReason() }),
    });
  });

  // Admin-features gate: teammate management is blocked until a valid
  // license is installed, unless the server is within the Free tier.
  // Login/register/device/promptowl/admin-status stay public so users can
  // sign in and reach the setup flow.
  app.use("/auth/invite", async (c, next) => {
    if (!getCurrentLicense()?.valid && !(await withinFreeTier())) {
      return c.json(
        {
          error: "License required",
          reason: FREE_TIER_EXCEEDED_MESSAGE,
        },
        503,
      );
    }
    return next();
  });
  app.use("/auth/teammates", async (c, next) => {
    if (!getCurrentLicense()?.valid && !(await withinFreeTier())) {
      return c.json(
        {
          error: "License required",
          reason: FREE_TIER_EXCEEDED_MESSAGE,
        },
        503,
      );
    }
    return next();
  });

  // Auth routes (always available — admin can create keys even in open mode)
  app.route("/auth", authRoutes);

  // ─── License setup endpoints (public — needed before unlock) ──────────
  // Public, so it says nothing about WHY a license lapsed (trial ended,
  // deactivated…) — that is between PromptOwl and the admin, on
  // GET /admin/license. `setup_required` is true only for a server that has
  // never been licensed; a workspace whose license lapsed stays usable
  // read-only instead of dropping everyone onto the activation screen.
  app.get("/license/status", (c) => {
    const lic = getCurrentLicense();
    return c.json({
      valid: !!lic?.valid,
      tier: lic?.tier || "none",
      org: lic?.org || null,
      owner_email: lic?.ownerEmail || null,
      suspended: !!lic?.suspended,
      suspended_reason: lic?.suspendedReason || null,
      limits: lic?.limits || null,
      setup_required: !lic?.valid && !getLicenseOwnerEmail(),
    });
  });

  // License detail for the people who can act on it — server admins and the
  // key's owner (even once it lapsed): the Settings → License tab and the
  // admin banner, including the live seat count.
  app.use("/admin/license", flexAuthMiddleware);
  app.get("/admin/license", async (c) => {
    if (!(await canSeeLicenseDetail(c.get("userId"))))
      return c.json({ error: "Only the server admin can view this." }, 403);
    const lic = getCurrentLicense();
    const ent = getEntitlement();
    const licensed = ent.maxUsers;
    const billed = await countBilled();
    const used = billed.users;
    return c.json({
      plan: ent.plan,
      subscribers: { licensed: ent.maxSubscribers, used: billed.subscribers },
      max_account_owners: ent.maxAccountOwners,
      valid: !!lic?.valid,
      tier: lic?.tier || "none",
      org: lic?.org || null,
      owner_email: lic?.ownerEmail || null,
      suspended: !!lic?.suspended,
      suspended_reason: lic?.suspendedReason || null,
      ...licenseTerms(lic),
      seats: {
        licensed,
        used,
        over_limit: licensed != null && used > licensed,
        at_limit: licensed != null && used >= licensed,
      },
      // Consecutive rejections PromptOwl has sent that haven't been acted on
      // yet (3 drop the license) — the "we're checking your license" banner.
      pending_rejections: getPendingRejections(),
      // Set while PromptOwl has been unreachable past the 24h offline limit
      // (the last good check); the server is read-only until it answers.
      offline_since: getOfflineLock(),
      last_checked_at: getLastLicenseCheck(),
      // Own model keys / LLM gateway (licence feature byok), for the License tab.
      byok: hasEntitlement("byok"),
      // PromptOwl's page for this key (plan, Upgrade); ?key= is the last 4 only.
      manage_url: config.PROMPTOWL_KEY
        ? `${config.PROMPTOWL_API_URL.replace(/\/$/, "")}/community-license?key=${config.PROMPTOWL_KEY.slice(-4)}`
        : null,
    });
  });

  // Installing the FIRST key is public — that's how a fresh server gets set
  // up. Once the server has a license owner, replacing the key is theirs (or
  // a server admin's) to do: a lapsed license must not let any visitor paste
  // their own key and become this server's admin.
  app.use("/license/install", async (c, next) =>
    getLicenseOwnerEmail() ? flexAuthMiddleware(c, next) : next(),
  );
  app.post("/license/install", async (c) => {
    if (getLicenseOwnerEmail() && !(await canSeeLicenseDetail(c.get("userId")))) {
      return c.json(
        { error: "Only the server admin can replace this server's license key." },
        403,
      );
    }
    let body: { key?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const key = body?.key?.trim();
    if (!key || !key.startsWith("pk_")) {
      return c.json(
        { error: "Invalid license key. Must start with pk_." },
        400,
      );
    }
    try {
      const info = await installLicenseKey(key);
      if (!info.valid) {
        return c.json(
          {
            valid: false,
            error: rejectedKeyMessage(info),
            ...licenseTerms(info),
          },
          400,
        );
      }
      return c.json({
        valid: true,
        tier: info.tier,
        org: info.org,
        limits: info.limits,
        // The key validated and is live now, but if it couldn't be saved to the
        // database it'll be lost on restart — surface that instead of pretending
        // the setup is durable (the old behavior silently swallowed this).
        persisted: info.persisted,
        ...(info.persisted
          ? {}
          : {
              warning: `License validated, but it could not be saved to the database (${
                info.persistError || "unknown error"
              }). It will be LOST on the next restart. Check the database connection, or provide PROMPTOWL_KEY via the container environment.`,
            }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to install key";
      return c.json({ error: msg }, 500);
    }
  });

  // Server-admin guard shared by the /admin/* operator surfaces: open mode,
  // the license admin, or a superadmin (access.yaml ∪ DB grants).
  const serverAdminAllowed = async (c: any) =>
    config.AUTH_MODE === "open" ||
    (await isServerAdminUserId(c.get("userId")));

  // /admin/settings — server-wide settings the admin edits from the Settings
  // page. Each setting takes effect live (config getters read process.env) and
  // persists durably so it survives a restart. In open mode the anonymous
  // admin may edit; in key mode it's the server admin (license admin or
  // superadmin) only.
  app.use("/admin/settings", flexAuthMiddleware);
  app.use("/admin/settings/*", flexAuthMiddleware);
  const currentServerSettings = () => ({
    promptowl_sign_in_gate: config.PROMPTOWL_SIGN_IN_GATE,
    manual_sign_in: config.MANUAL_SIGN_IN,
    // True while password self-registration is open alongside live SSO —
    // the Settings page shows a warning on the Manual sign-in card.
    manual_sign_in_open_with_sso: config.MANUAL_SIGN_IN_OPEN_WITH_SSO,
    community_name: config.COMMUNITY_NAME,
    logo_url: config.LOGO_URL,
    telemetry_enabled: config.TELEMETRY_ENABLED,
    posthog_key: config.POSTHOG_KEY,
    posthog_host: config.POSTHOG_HOST,
    public_base_url: config.PUBLIC_BASE_URL,
    max_body_bytes: config.MAX_BODY_BYTES,
    workflow_plane_enabled: config.FEATURE_WORKFLOW_PLANE,
    promptowl_teams_enabled: config.PROMPTOWL_TEAMS_ENABLED,
    type_artifact_enabled: config.TYPE_ARTIFACT_ENABLED,
    type_table_enabled: config.TYPE_TABLE_ENABLED,
    type_task_enabled: ACCEPTED_NODE_TYPES.has("task"),
    hootie_enabled: config.HOOTIE_ENABLED,
    // The model in use: the admin's pick, else the gateway's default (see hootieModel).
    hootie_model: hootieModel(resolveModelCredential()),
    // Custom identity (enterprise). The stored values are returned even when
    // the licence doesn't allow them, so a lapsed licence shows what would
    // come back on renewal; `hootie_branding_available` says whether they
    // are in effect and whether edits are accepted.
    ...storedHootieSettings(),
    hootie_branding_available: hootieBrandingAvailable(),
    // Own model keys are in effect and editable only with byok.
    byok_available: hasEntitlement("byok"),
    // Own-provider keys PromptOwl holds for this licence (masked tails only).
    own_providers: hasEntitlement("byok") ? getOwnGateway()?.providers ?? {} : {},
    // The server's own model gateway (byok): URL + key used as a pair, ahead of
    // PromptOwl's gateway. The key is NEVER returned — masked tail only.
    anthropic_base_url: config.ANTHROPIC_BASE_URL,
    anthropic_api_key_masked: process.env.ANTHROPIC_API_KEY
      ? `••••${process.env.ANTHROPIC_API_KEY.slice(-4)}`
      : null,
    // Which key Hootie's calls use: own (the server's gateway) or promptowl (credits).
    model_source: resolveModelCredential()?.source ?? null,
    subagent_runs_enabled: config.FEATURE_SUBAGENT_RUNS,
    metacognition_enabled: config.FEATURE_METACOGNITION,
    experimental_doc_pins: config.EXPERIMENTAL_DOC_PINS,
    subagent_max_depth: config.SUBAGENT_MAX_DEPTH,
    subagent_max_children: config.SUBAGENT_MAX_CHILDREN,
    trace_retention_days: config.TRACE_RETENTION_DAYS,
    // Unset shows the engine's default bound.
    import_io_concurrency: config.IMPORT_IO_CONCURRENCY ?? 32,
    message_log_retention_days: config.MESSAGE_LOG_RETENTION_DAYS,
    message_log_store_bodies: config.MESSAGE_LOG_STORE_BODIES,
    run_retention_days: config.RUN_RETENTION_DAYS,
    // OIDC SSO. The client secret is WRITE-ONLY: only its presence is
    // reported, never the value.
    oidc_enabled: config.OIDC_ENABLED,
    oidc_issuer: config.OIDC_ISSUER,
    oidc_client_id: config.OIDC_CLIENT_ID,
    oidc_client_secret_set: !!config.OIDC_CLIENT_SECRET,
    oidc_allowed_domains: config.OIDC_ALLOWED_DOMAINS.join(", "),
    oidc_auto_provision: config.OIDC_AUTO_PROVISION,
    oidc_department_tagging: config.OIDC_DEPARTMENT_TAGGING,
    // Enterprise identity providers allowed (licence feature sso). Google is on every plan.
    sso_available: hasEntitlement("sso"),
    nest_creation: config.NEST_CREATION,
    people_suggest_all_users: config.PEOPLE_SUGGEST_ALL_USERS,
    shared_deployment: config.SHARED_DEPLOYMENT,
    mcp_oauth_enabled: config.MCP_OAUTH_ENABLED,
    // Agent SSO / token-exchange. MCP_SIGNING_SECRET is WRITE-ONLY — only its
    // presence is reported, never the value (same discipline as the OIDC secret).
    sso_token_exchange_enabled: config.SSO_TOKEN_EXCHANGE_ENABLED,
    mcp_signing_secret_set: !!config.MCP_SIGNING_SECRET,
    mcp_token_ttl_seconds: config.MCP_TOKEN_TTL_SECONDS,
    ms_token_exchange_enabled: config.MS_TOKEN_EXCHANGE_ENABLED,
    ms_client_id: config.MS_CLIENT_ID,
    ms_tenant_id: config.MS_TENANT_ID,
    google_token_exchange_enabled: config.GOOGLE_TOKEN_EXCHANGE_ENABLED,
    google_client_id: config.GOOGLE_CLIENT_ID,
    // Live readiness (enabled AND issuer+id+secret present) — the SAVED state,
    // i.e. whether the login button is currently live. The Settings UI derives
    // its own "enabled but not configured" warning from the unsaved draft
    // instead, so this is for API consumers (and tests) rather than that badge.
    oidc_ready: isOidcReady(),
    slack_webhook_url: config.SLACK_WEBHOOK_URL ?? "",
    msteams_webhook_url: config.MSTEAMS_WEBHOOK_URL ?? "",
    email_provider: config.EMAIL_PROVIDER,
    smtp_url: config.SMTP_URL ?? "",
    ses_region: config.SES_REGION ?? "",
    ses_access_key_id: config.SES_ACCESS_KEY_ID ?? "",
    // Write-only, like the OIDC secret — presence only, never the value.
    ses_secret_access_key_set: !!config.SES_SECRET_ACCESS_KEY,
    notify_email_from: config.NOTIFY_EMAIL_FROM ?? "",
    notify_email_to: config.NOTIFY_EMAIL_TO ?? "",
  });

  app.get("/admin/settings", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can view this." }, 403);
    return c.json(currentServerSettings());
  });

  // Models the current credential can reach — the Hootie model picker. On the
  // PromptOwl gateway that is PromptOwl's team catalog (team model names); on
  // an own key (byok), whatever that key's provider/gateway lists. With byok,
  // the licence's own-provider models are added and named in `own_models`.
  app.use("/admin/models", flexAuthMiddleware);
  app.get("/admin/models", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can view this." }, 403);
    const credential = resolveModelCredential();
    const current = hootieModel(credential);
    // On the server's own gateway every call stays there, so PromptOwl-held
    // own-provider models aren't offered.
    const own = hasEntitlement("byok") && credential?.source !== "own" ? getOwnGateway()?.models ?? [] : [];
    // `providers`: name → provider, read before PromptOwl's prefix comes off,
    // so the picker can group the list (OpenAI, Anthropic, …).
    const reply = (ids: string[], names: string[], extra: Record<string, unknown> = {}) => {
      const providers: Record<string, string> = {};
      names.forEach((n, i) => (providers[n] = modelProvider(ids[i])));
      for (const m of own) providers[m] = modelProvider(m);
      return c.json({
        models: [...new Set([...names, ...own])].sort(),
        current,
        source: credential?.source ?? null,
        providers,
        ...(own.length ? { own_models: own } : {}),
        ...extra,
      });
    };
    if (!credential) return reply([], []);
    try {
      const ids = await listCredentialModels(credential);
      // People pick plain names; PromptOwl's instance prefix is added per call.
      return reply(ids, credential.source === "promptowl" ? ids.map(bareModelName) : ids);
    } catch (err) {
      console.warn("[admin/models] could not list models:", err instanceof Error ? err.message : err);
      return reply([], [], { error: "Could not list models right now." });
    }
  });

  // Send a test notification to the saved Slack/Teams webhook so the admin can
  // confirm the connector works without waiting for a real governance event.
  app.post("/admin/settings/test-notification", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can do this." }, 403);
    let body: { channel?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (body.channel !== "slack" && body.channel !== "teams")
      return c.json({ error: "channel must be 'slack' or 'teams'" }, 400);
    const result = await sendTestNotification(body.channel);
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 502);
  });

  // Network & status (Settings → Network & status). Admin-only, secret-free:
  // see src/ops/status.ts. The probes only ever dial hosts derived from this
  // server's own config (never a URL from the request), are rate-limited, and
  // never follow redirects.
  app.use("/admin/status", flexAuthMiddleware);
  app.use("/admin/status/*", flexAuthMiddleware);
  const OPS_PROBE_LIMIT = { max: 10, windowMs: 60_000 };
  const opsProbeAllowed = (c: any) =>
    tryConsume(`ops-probe:${c.get("userId") ?? clientIp(c)}`, OPS_PROBE_LIMIT);

  app.get("/admin/status", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can view this." }, 403);
    const { buildStatusReport } = await import("./ops/status.js");
    return c.json(await buildStatusReport(c.req.url, (name) => c.req.header(name)));
  });

  for (const [path, run] of [
    ["egress", async () => (await import("./ops/egress.js")).runEgressChecks()],
    ["inbound", async () => (await import("./ops/egress.js")).runInboundCheck()],
    ["oidc-discovery", async () => (await import("./ops/egress.js")).runOidcDiscoveryCheck()],
  ] as const) {
    app.post(`/admin/status/${path}`, async (c) => {
      if (!(await serverAdminAllowed(c)))
        return c.json({ error: "Only the server admin can do this." }, 403);
      if (!opsProbeAllowed(c))
        return c.json({ error: "Too many checks — wait a minute and try again." }, 429);
      return c.json(await run());
    });
  }

  app.patch("/admin/settings", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can change this." }, 403);
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    // Validate every supplied field FIRST and stage the changes. Nothing is
    // applied (live env or disk) until all fields pass, so a single bad field
    // can't leave the server in a half-updated state that disagrees with the
    // 400 response. null value deletes the line (setting falls to its default).
    // Validation failures are keyed by the request field name (the same key the
    // UI sends and groups under a tab) so the client can focus the offending
    // field's tab deterministically instead of scraping the message text.
    const fieldErrors: Record<string, string> = {};
    const addError = (field: string, message: string) => {
      fieldErrors[field] = message;
    };
    const pending: Array<{ name: string; value: string | null }> = [];

    // Custom assistant identity is an enterprise entitlement. A request that
    // would CHANGE it is refused whole — nothing written, not even its other
    // fields — so a non-enterprise server never holds a half-applied edit.
    // Branding fields that only echo the stored values are dropped, so a
    // client that sends a whole form can still save unrelated settings.
    if (!hootieBrandingAvailable()) {
      if (changedHootieBrandFields(body).length > 0) {
        return c.json(
          {
            error:
              "Custom assistant name and branding are an Enterprise feature. Upgrade the licence to change them.",
            code: "enterprise_required",
            settings: currentServerSettings(),
          },
          403,
        );
      }
      for (const k of Object.keys(HOOTIE_BRAND_FIELDS)) delete body[k];
    }

    // Own model keys: Enterprise only (pricing spec §9.3, licence feature
    // byok). Setting one is refused whole; clearing is always allowed.
    const providerKeysIn =
      body.provider_keys && typeof body.provider_keys === "object" && !Array.isArray(body.provider_keys)
        ? (body.provider_keys as Record<string, unknown>)
        : null;
    if (
      !hasEntitlement("byok") &&
      ((["anthropic_api_key", "anthropic_base_url"] as const).some(
        (f) => f in body && String(body[f] ?? "").trim() !== "",
      ) ||
        Object.values(providerKeysIn ?? {}).some((v) => String(v ?? "").trim() !== ""))
    ) {
      return c.json(
        {
          error:
            "Models on this server are supplied by PromptOwl. Using your own model key or gateway is an Enterprise feature.",
          code: "byok_required",
          settings: currentServerSettings(),
        },
        403,
      );
    }

    // Enterprise IdPs (Entra, Okta, custom OIDC): Enterprise only (licence
    // feature sso). Only switching to one or turning it on is refused, so a
    // server already on one keeps signing in. Google is on every plan.
    if (!hasEntitlement("sso")) {
      const issuer =
        "oidc_issuer" in body ? String(body.oidc_issuer ?? "").trim().replace(/\/$/, "") : config.OIDC_ISSUER;
      const turningOn = "oidc_enabled" in body && !!body.oidc_enabled && !config.OIDC_ENABLED;
      if (isEnterpriseIssuer(issuer) && (issuer !== config.OIDC_ISSUER || turningOn)) {
        return c.json(
          {
            error:
              "Single sign-on with Entra ID, Okta or another identity provider is an Enterprise feature. Google sign-in works on every plan.",
            code: "sso_required",
            settings: currentServerSettings(),
          },
          403,
        );
      }
    }

    if ("promptowl_sign_in_gate" in body) {
      const v = String(body.promptowl_sign_in_gate ?? "").trim().toLowerCase();
      if (!["open", "admin-only", "disabled"].includes(v))
        addError("promptowl_sign_in_gate", "PromptOwl sign-in must be set to Everyone, Admins only, or Off.");
      else pending.push({ name: "PROMPTOWL_SIGN_IN_GATE", value: v });
    }
    if ("manual_sign_in" in body) {
      const v = String(body.manual_sign_in ?? "").trim().toLowerCase();
      if (!["open", "invite-only", "disabled"].includes(v))
        addError("manual_sign_in", "Manual sign-in must be set to Everyone, Invite only, or Off.");
      else pending.push({ name: "MANUAL_SIGN_IN", value: v });
    }
    if ("logo_url" in body) {
      const v = String(body.logo_url ?? "").trim();
      pending.push({ name: "LOGO_URL", value: v || null });
    }
    if ("community_name" in body) {
      const v = String(body.community_name ?? "").trim();
      if (v.length > 100 || /[\r\n]/.test(v))
        addError("community_name", "Community name must be one line, 100 characters or fewer.");
      else pending.push({ name: "COMMUNITY_NAME", value: v || null });
    }
    // Validated, not just trimmed. This value is spliced into the copy-paste
    // snippets the Connecting-agents panel renders — a `bash` block for the
    // Claude Code and Codex commands, and quoted strings in config.toml,
    // config.yaml and mcp.json — which people paste verbatim into their own
    // terminal and config files. Stored unchecked, a shell metacharacter or a
    // quote here would turn "can edit server settings" into code execution on
    // every teammate's machine. It is also the audience a minted MCP ticket is
    // bound to, so junk in it silently breaks token verification.
    if ("public_base_url" in body) {
      const v = String(body.public_base_url ?? "").trim().replace(/\/$/, "");
      const err = v ? publicBaseUrlError(v) : null;
      if (err) addError("public_base_url", err);
      else pending.push({ name: "PUBLIC_BASE_URL", value: v || null });
    }
    if ("telemetry_enabled" in body) {
      pending.push({ name: "TELEMETRY_ENABLED", value: body.telemetry_enabled ? "true" : "false" });
    }
    // PostHog: empty key clears the row and turns analytics off. Both fields
    // are checked here because a typo'd key or host fails silently in the
    // browser; a project key is "phc_" plus a long alphanumeric token. The
    // message names the rule that failed so a near-miss is not a mystery.
    if ("posthog_key" in body) {
      const v = String(body.posthog_key ?? "").trim();
      const keyError = posthogKeyError(v);
      if (keyError) addError("posthog_key", keyError);
      else pending.push({ name: "POSTHOG_KEY", value: v || null });
    }
    if ("posthog_host" in body) {
      const v = String(body.posthog_host ?? "").trim().replace(/\/$/, "");
      if (v && !/^https?:\/\/[^\s]+$/i.test(v))
        addError("posthog_host", "PostHog host must be a http(s) URL, e.g. https://us.i.posthog.com");
      else pending.push({ name: "POSTHOG_HOST", value: v || null });
    }
    if ("workflow_plane_enabled" in body) {
      pending.push({
        name: "FEATURE_WORKFLOW_PLANE",
        value: body.workflow_plane_enabled ? "true" : null,
      });
    }
    // Import teams from PromptOwl. Default OFF — enabling writes "true",
    // disabling clears the row (falls back to the default).
    if ("promptowl_teams_enabled" in body) {
      pending.push({
        name: "PROMPTOWL_TEAMS_ENABLED",
        value: body.promptowl_teams_enabled ? "true" : null,
      });
    }
    // Content-type toggles. Default ON — an explicit "false" is the only
    // disabled state, so enabling clears the row (falls to the default) and
    // env-set values gate identically to UI-set ones.
    if ("type_artifact_enabled" in body) {
      pending.push({
        name: "TYPE_ARTIFACT_ENABLED",
        value: body.type_artifact_enabled ? null : "false",
      });
    }
    if ("type_table_enabled" in body) {
      pending.push({
        name: "TYPE_TABLE_ENABLED",
        value: body.type_table_enabled ? null : "false",
      });
    }
    // Default OFF (CU-wdqcq03ewc). Both states are written explicitly so a
    // UI choice beats a deploy env of either value (db/settings.ts precedence).
    if ("hootie_enabled" in body) {
      pending.push({
        name: "HOOTIE_ENABLED",
        value: body.hootie_enabled ? "true" : "false",
      });
    }
    if ("hootie_model" in body) {
      const v = String(body.hootie_model ?? "").trim();
      if (!v) addError("hootie_model", "Model is required — e.g. claude-sonnet-5.");
      else if (v.length > 200 || /\s/.test(v))
        addError("hootie_model", "Model must be a single identifier with no spaces.");
      else pending.push({ name: "HOOTIE_MODEL", value: v === "claude-sonnet-5" ? null : v });
    }
    // Name, logo, accent colour, greeting (enterprise — gated above).
    pending.push(...validateHootieBrandFields(body, addError));
    // The server's own model gateway (byok, gated above): an http(s) URL with
    // no trailing slash, so the SDK joins /v1/messages onto it; empty clears.
    if ("anthropic_base_url" in body) {
      const v = String(body.anthropic_base_url ?? "").trim().replace(/\/$/, "");
      if (!v) {
        // The key goes with it: left alone, a bare key would be handed to
        // PromptOwl's gateway at the next boot (moveStoredAnthropicKey).
        pending.push({ name: "ANTHROPIC_BASE_URL", value: null });
        // Only a key that WAS paired with a URL: a bare key waits for hand-over.
        if (config.ANTHROPIC_BASE_URL && !("anthropic_api_key" in body))
          pending.push({ name: "ANTHROPIC_API_KEY", value: null });
      } else {
        let ok = false;
        try {
          const u = new URL(v);
          ok = (u.protocol === "http:" || u.protocol === "https:") && !!u.host;
        } catch {
          ok = false;
        }
        if (!ok)
          addError(
            "anthropic_base_url",
            "Model gateway URL must be an http(s) URL, e.g. http://litellm:4000 — or empty to turn it off.",
          );
        else if (v !== config.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_API_KEY && !("anthropic_api_key" in body))
          // The stored key is write-only: never send it to a host it wasn't checked against.
          addError("anthropic_api_key", "Paste the gateway key again: a new gateway URL needs its key re-entered.");
        else pending.push({ name: "ANTHROPIC_BASE_URL", value: v });
      }
    }
    // The gateway's key (a LiteLLM virtual key, or an Anthropic key behind a
    // proxy). Any non-empty string: gateways mint their own formats. Checked
    // against the gateway THIS patch leaves in place before it is saved.
    if ("anthropic_api_key" in body) {
      const v = body.anthropic_api_key;
      if (v === null || v === "") {
        pending.push({ name: "ANTHROPIC_API_KEY", value: null });
      } else if (typeof v !== "string" || !v.trim() || /\s/.test(v.trim()) || v.trim().length > 512) {
        addError("anthropic_api_key", "Gateway key must be a single token with no spaces, up to 512 characters (or empty to clear it).");
      } else {
        const key = v.trim();
        const patchedBase = pending.find((p) => p.name === "ANTHROPIC_BASE_URL");
        const baseUrl = patchedBase ? patchedBase.value : config.ANTHROPIC_BASE_URL || null;
        if (!baseUrl) {
          addError("anthropic_api_key", "Set the model gateway URL too: the key is only used with it.");
        } else {
          const rejected = await verifyModelKey(key, baseUrl);
          if (rejected) addError("anthropic_api_key", rejected);
          else pending.push({ name: "ANTHROPIC_API_KEY", value: key });
        }
      }
    }
    // Own-provider keys (byok): checked and stored by PromptOwl, in LiteLLM
    // only — sent after every other field validates, never kept here.
    const providerKeys: Array<[string, string | null]> = [];
    if ("provider_keys" in body) {
      if (!providerKeysIn) addError("provider_keys", "provider_keys must be an object of provider → key.");
      else
        for (const [p, v] of Object.entries(providerKeysIn)) {
          const field = `provider_keys.${p}`;
          if (!(OWN_KEY_PROVIDERS as readonly string[]).includes(p)) addError(field, `Unknown model provider "${p}".`);
          else if (v === null || v === "") providerKeys.push([p, null]);
          else if (typeof v !== "string" || !v.trim() || /\s/.test(v.trim()) || v.trim().length > 512)
            addError(field, "Paste the provider's API key as one line.");
          else providerKeys.push([p, v.trim()]);
        }
    }
    if ("subagent_runs_enabled" in body) {
      // Depends on the plane: enabling recursion without the plane's run routes
      // is inert (they'd 404). Honour the plane state THIS request sets, so a
      // single patch can turn both on together. This flag opens a recursion
      // surface — it's gated separately by design and should only be flipped
      // after the security review the feature ships behind.
      const planeOn =
        "workflow_plane_enabled" in body
          ? !!body.workflow_plane_enabled
          : config.FEATURE_WORKFLOW_PLANE;
      if (body.subagent_runs_enabled && !planeOn) {
        addError(
          "subagent_runs_enabled",
          "Sub-agent runs require the Workflow plane to be turned on.",
        );
      } else {
        pending.push({
          name: "FEATURE_SUBAGENT_RUNS",
          value: body.subagent_runs_enabled ? "true" : null,
        });
      }
    }
    // Metacognition agents run on the plane's runs and schedules, so they
    // need it on, same as sub-agent runs. Off clears the row (falls to env).
    if ("metacognition_enabled" in body) {
      const planeOn =
        "workflow_plane_enabled" in body ? !!body.workflow_plane_enabled : config.FEATURE_WORKFLOW_PLANE;
      if (body.metacognition_enabled && !planeOn) {
        addError("metacognition_enabled", "Metacognition agents require the Workflow plane to be turned on.");
      } else {
        pending.push({ name: "FEATURE_METACOGNITION", value: body.metacognition_enabled ? "true" : null });
      }
    }
    // Experimental: document pins (CU-wdqcq02crw). Default OFF — enabling
    // writes "true", disabling clears the row (falls back to the default).
    if ("experimental_doc_pins" in body) {
      pending.push({
        name: "EXPERIMENTAL_DOC_PINS",
        value: body.experimental_doc_pins ? "true" : null,
      });
    }
    // Sub-agent recursion caps. Same [min,max] the config getters clamp to, so
    // a UI-set value gates identically to an env-set one. null clears → default.
    if ("subagent_max_depth" in body) {
      const v = body.subagent_max_depth;
      if (v === null || v === "") {
        pending.push({ name: "SUBAGENT_MAX_DEPTH", value: null });
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 32)
          addError("subagent_max_depth", "Max sub-agent depth must be a whole number between 1 and 32.");
        else pending.push({ name: "SUBAGENT_MAX_DEPTH", value: String(n) });
      }
    }
    if ("subagent_max_children" in body) {
      const v = body.subagent_max_children;
      if (v === null || v === "") {
        pending.push({ name: "SUBAGENT_MAX_CHILDREN", value: null });
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 128)
          addError("subagent_max_children", "Max sub-agents per run must be a whole number between 1 and 128.");
        else pending.push({ name: "SUBAGENT_MAX_CHILDREN", value: String(n) });
      }
    }
    // Activity-trace retention window in days. Same [0, 3650] range the config
    // getter caps to, so a UI-set value gates identically to an env-set one.
    // 0 = keep forever (pruning skipped). null clears → default (14).
    if ("trace_retention_days" in body) {
      const v = body.trace_retention_days;
      if (v === null || v === "") {
        pending.push({ name: "TRACE_RETENTION_DAYS", value: null });
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 3650)
          addError("trace_retention_days", "Trace retention must be a whole number of days between 0 and 3650 (0 keeps activity forever).");
        else pending.push({ name: "TRACE_RETENTION_DAYS", value: String(n) });
      }
    }
    // Import I/O bound (engine limits.ioConcurrency). Capped: each in-flight
    // file is held in memory. null clears → engine default (32).
    if ("import_io_concurrency" in body) {
      const v = body.import_io_concurrency;
      const n = Number(v);
      if (v === null || v === "") pending.push({ name: "IMPORT_IO_CONCURRENCY", value: null });
      else if (!Number.isInteger(n) || n < 1 || n > 256)
        addError("import_io_concurrency", "Import concurrency must be a whole number between 1 and 256.");
      else pending.push({ name: "IMPORT_IO_CONCURRENCY", value: String(n) });
    }
    // Message-log retention (outbound_messages). Same [0, 3650] range as the
    // getter; 0 keeps messages forever, null clears → default (30).
    if ("message_log_retention_days" in body) {
      const v = body.message_log_retention_days;
      if (v === null || v === "") {
        pending.push({ name: "MESSAGE_LOG_RETENTION_DAYS", value: null });
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 3650)
          addError("message_log_retention_days", "Message log retention must be a whole number of days between 0 and 3650 (0 keeps messages forever).");
        else pending.push({ name: "MESSAGE_LOG_RETENTION_DAYS", value: String(n) });
      }
    }
    // Store redacted bodies (default on). Off persists "false"; on clears to
    // the default so an unset env stays the source of truth.
    if ("message_log_store_bodies" in body) {
      pending.push({
        name: "MESSAGE_LOG_STORE_BODIES",
        value: body.message_log_store_bodies ? null : "false",
      });
    }
    // Agent-run retention in days. Same [0, 3650] range as the config getter.
    // 0 = keep every run (the default). null clears → default (0).
    if ("run_retention_days" in body) {
      const v = body.run_retention_days;
      if (v === null || v === "") {
        pending.push({ name: "RUN_RETENTION_DAYS", value: null });
      } else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 3650)
          addError("run_retention_days", "Run retention must be a whole number of days between 0 and 3650 (0 keeps every run).");
        else pending.push({ name: "RUN_RETENTION_DAYS", value: String(n) });
      }
    }
    // ── OIDC SSO ──
    // The client secret is write-only: a non-empty string overwrites, null or
    // "" clears, and GET only ever reports `oidc_client_secret_set`. Issuer
    // must be a https URL (the trust root of the whole flow). Enabling
    // requires the effective post-PATCH config to be complete, so the toggle
    // can never be left on with a login button that just bounces errors.
    if ("oidc_issuer" in body) {
      const v = String(body.oidc_issuer ?? "").trim().replace(/\/$/, "");
      let ok = false;
      try {
        ok = !v || new URL(v).protocol === "https:";
      } catch {
        ok = false;
      }
      if (!ok)
        addError("oidc_issuer", "OIDC issuer must be a valid https:// URL (e.g. https://accounts.google.com), or empty to clear it.");
      else pending.push({ name: "OIDC_ISSUER", value: v || null });
    }
    if ("oidc_client_id" in body) {
      const v = String(body.oidc_client_id ?? "").trim();
      pending.push({ name: "OIDC_CLIENT_ID", value: v || null });
    }
    if ("oidc_client_secret" in body) {
      const v = body.oidc_client_secret;
      if (v === null || v === "") {
        pending.push({ name: "OIDC_CLIENT_SECRET", value: null });
      } else if (typeof v !== "string") {
        addError("oidc_client_secret", "OIDC client secret must be a string (or empty to clear it).");
      } else {
        pending.push({ name: "OIDC_CLIENT_SECRET", value: v.trim() });
      }
    }
    if ("oidc_allowed_domains" in body) {
      const raw = String(body.oidc_allowed_domains ?? "").trim();
      const entries = raw
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
      // Bare hostnames only — an entry with "@", a scheme, a slash, or no dot
      // is a typo'd email/URL, not a domain, and would silently never match.
      const bad = entries.find((d) => !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d));
      if (bad !== undefined)
        addError("oidc_allowed_domains", `"${bad}" is not a valid domain — use bare domains, comma-separated (e.g. acme.com, contractors.acme.com), or leave empty to allow any.`);
      else
        pending.push({
          name: "OIDC_ALLOWED_DOMAINS",
          value: entries.length ? entries.join(",") : null,
        });
    }
    if ("oidc_auto_provision" in body) {
      pending.push({
        name: "OIDC_AUTO_PROVISION",
        value: body.oidc_auto_provision ? "true" : "false",
      });
    }
    // Department auto-tagging (dept:<slug> on node create). Only meaningful
    // when an OIDC IdP emits the `department` claim, but deliberately NOT
    // gated on oidc_enabled — the toggle is inert without a department to
    // read, never harmful. Default off; false persists as null (unset) rather
    // than "false" because unset already means off — unlike oidc_auto_provision
    // above, whose default is ON and so needs an explicit "false" to disable.
    if ("oidc_department_tagging" in body) {
      pending.push({
        name: "OIDC_DEPARTMENT_TAGGING",
        value: body.oidc_department_tagging ? "true" : null,
      });
    }
    // Add-a-person suggestions over the whole user table. Default off because
    // this server may be multi-tenant (the PromptOwl-hosted deployment holds
    // many customers), where "every registered account" means another
    // customer's staff. false persists as null — unset already means off.
    if ("nest_creation" in body) {
      const v = String(body.nest_creation ?? "").trim().toLowerCase();
      if (v !== "admins" && v !== "everyone")
        addError("nest_creation", "Nest creation must be admins or everyone.");
      else pending.push({ name: "NEST_CREATION", value: v });
    }
    if ("people_suggest_all_users" in body) {
      pending.push({
        name: "PEOPLE_SUGGEST_ALL_USERS",
        value: body.people_suggest_all_users ? "true" : null,
      });
    }
    // This server hosts several organizations. On, nest visibility 'org'
    // needs the same acknowledgement as 'public' and the UI words both tiers
    // to name the real boundary. false persists as null — unset is off.
    if ("shared_deployment" in body) {
      pending.push({
        name: "SHARED_DEPLOYMENT",
        value: body.shared_deployment ? "true" : null,
      });
    }
    // MCP OAuth authorization server. Turning it on without a canonical base
    // URL produces metadata that cannot be correct — `resource` has to equal
    // the URL the user types into their client — so the feature would be on
    // and silently broken. Refuse the combination with a reason instead of
    // letting an admin discover it through a failing connector. The base URL
    // may be set in this same PATCH, so read the pending value first.
    if ("mcp_oauth_enabled" in body) {
      const turningOn = !!body.mcp_oauth_enabled;
      const pendingBase = pending.find((p) => p.name === "PUBLIC_BASE_URL");
      const baseAfter =
        pendingBase !== undefined ? pendingBase.value : config.PUBLIC_BASE_URL;
      if (turningOn && !baseAfter) {
        addError(
          "mcp_oauth_enabled",
          "Set the public base URL first — OAuth metadata must name this server's canonical address, and a guessed one silently fails the client's check.",
        );
      } else {
        pending.push({
          name: "MCP_OAUTH_ENABLED",
          value: turningOn ? "true" : null,
        });
      }
    }
    // ── Agent SSO / token-exchange (POST /auth/token-exchange) ────────────
    // Default-off toggles persist "false" as null (unset already = off). The
    // MCP signing secret is write-only, same discipline as oidc_client_secret.
    if ("sso_token_exchange_enabled" in body) {
      pending.push({
        name: "SSO_TOKEN_EXCHANGE_ENABLED",
        value: body.sso_token_exchange_enabled ? "true" : null,
      });
    }
    if ("mcp_signing_secret" in body) {
      const v = body.mcp_signing_secret;
      if (v === null || v === "") {
        pending.push({ name: "MCP_SIGNING_SECRET", value: null });
      } else if (typeof v !== "string") {
        addError("mcp_signing_secret", "MCP signing secret must be a string (or empty to clear it).");
      } else if (v.trim().length < 16) {
        addError("mcp_signing_secret", "MCP signing secret should be a long random string (16+ characters).");
      } else {
        pending.push({ name: "MCP_SIGNING_SECRET", value: v.trim() });
      }
    }
    if ("mcp_token_ttl_seconds" in body) {
      const n = Number(body.mcp_token_ttl_seconds);
      if (!Number.isFinite(n) || n < 30 || n > 3600) {
        addError("mcp_token_ttl_seconds", "Token lifetime must be between 30 and 3600 seconds.");
      } else {
        pending.push({ name: "MCP_TOKEN_TTL_SECONDS", value: String(Math.floor(n)) });
      }
    }
    if ("ms_token_exchange_enabled" in body) {
      pending.push({
        name: "MS_TOKEN_EXCHANGE_ENABLED",
        value: body.ms_token_exchange_enabled ? "true" : null,
      });
    }
    if ("ms_client_id" in body) {
      pending.push({ name: "MS_CLIENT_ID", value: String(body.ms_client_id ?? "").trim() || null });
    }
    if ("ms_tenant_id" in body) {
      pending.push({ name: "MS_TENANT_ID", value: String(body.ms_tenant_id ?? "").trim() || null });
    }
    if ("google_token_exchange_enabled" in body) {
      pending.push({
        name: "GOOGLE_TOKEN_EXCHANGE_ENABLED",
        value: body.google_token_exchange_enabled ? "true" : null,
      });
    }
    if ("google_client_id" in body) {
      pending.push({ name: "GOOGLE_CLIENT_ID", value: String(body.google_client_id ?? "").trim() || null });
    }
    // Fail-closed guard on the combination, not on either field alone: a
    // provider enabled while unknown emails may JIT-provision AND no domain
    // allowlist bounds them means any account at that IdP (Google = the whole
    // internet) can exchange a token for a bearer on an account it just made.
    // Effective post-PATCH values, so setting the allowlist in the SAME request
    // that flips the toggle is accepted. The endpoint refuses that combination
    // at mint time too — this only stops an admin from saving it blind.
    const effAllowedDomains =
      "oidc_allowed_domains" in body
        ? String(body.oidc_allowed_domains ?? "")
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean)
        : config.OIDC_ALLOWED_DOMAINS;
    const effAutoProvision =
      "oidc_auto_provision" in body
        ? !!body.oidc_auto_provision
        : config.OIDC_AUTO_PROVISION;
    if (effAutoProvision && effAllowedDomains.length === 0) {
      for (const field of [
        "ms_token_exchange_enabled",
        "google_token_exchange_enabled",
      ] as const) {
        if (body[field])
          addError(
            field,
            "Set allowed email domains (or turn auto-provision off) before enabling token exchange — otherwise anyone with an account at that provider can sign themselves up and mint a token.",
          );
      }
    }
    // Effective post-PATCH OIDC state: what this request sets, falling back
    // to current config for fields it doesn't touch. Shared by the enable
    // guard here AND the total-lockout guard below (SSO-only servers are a
    // supported configuration, so the lockout check must see OIDC too).
    const effOidcIssuer =
      "oidc_issuer" in body
        ? String(body.oidc_issuer ?? "").trim()
        : config.OIDC_ISSUER;
    const effOidcClientId =
      "oidc_client_id" in body
        ? String(body.oidc_client_id ?? "").trim()
        : config.OIDC_CLIENT_ID;
    const effOidcSecret =
      "oidc_client_secret" in body
        ? String(body.oidc_client_secret ?? "").trim()
        : config.OIDC_CLIENT_SECRET;
    const effOidcEnabled =
      "oidc_enabled" in body ? !!body.oidc_enabled : config.OIDC_ENABLED;
    const effOidcReady =
      effOidcEnabled && !!effOidcIssuer && !!effOidcClientId && !!effOidcSecret;
    if ("oidc_enabled" in body) {
      if (body.oidc_enabled && !effOidcReady) {
        addError(
          "oidc_enabled",
          "Set the OIDC issuer, client ID, and client secret before turning single sign-on on.",
        );
      } else {
        pending.push({
          name: "OIDC_ENABLED",
          value: body.oidc_enabled ? "true" : null,
        });
      }
    }
    if ("slack_webhook_url" in body) {
      const v = String(body.slack_webhook_url ?? "").trim();
      // Empty clears (connector off). A webhook URL carries an implicit
      // secret in its path — https only.
      if (v && !/^https:\/\//i.test(v))
        addError("slack_webhook_url", "Slack webhook must be an https:// URL (or leave it empty to turn Slack notifications off).");
      else pending.push({ name: "SLACK_WEBHOOK_URL", value: v || null });
    }
    if ("msteams_webhook_url" in body) {
      const v = String(body.msteams_webhook_url ?? "").trim();
      // Empty clears (connector off). A webhook URL carries an implicit
      // secret in its path — https only. msteams_*, never teams_*: "teams"
      // in this codebase means user groups.
      if (v && !/^https:\/\//i.test(v))
        addError("msteams_webhook_url", "Microsoft Teams webhook must be an https:// URL (or leave it empty to turn Teams notifications off).");
      else pending.push({ name: "MSTEAMS_WEBHOOK_URL", value: v || null });
    }
    if ("smtp_url" in body) {
      const v = String(body.smtp_url ?? "").trim();
      if (v && !/^smtps?:\/\//i.test(v))
        addError("smtp_url", "SMTP connection URL must start with smtp:// or smtps:// (or leave it empty to turn email notifications off).");
      else pending.push({ name: "SMTP_URL", value: v || null });
    }
    if ("email_provider" in body) {
      const v = String(body.email_provider ?? "").trim().toLowerCase();
      if (v !== "smtp" && v !== "ses")
        addError("email_provider", "Email provider must be SMTP or AWS SES.");
      else pending.push({ name: "EMAIL_PROVIDER", value: v });
    }
    if ("ses_region" in body) {
      const v = String(body.ses_region ?? "").trim();
      if (v && !/^[a-z]{2}(-[a-z]+)+-\d+$/.test(v))
        addError("ses_region", "AWS region must look like us-east-1.");
      else pending.push({ name: "SES_REGION", value: v || null });
    }
    if ("ses_access_key_id" in body) {
      const v = String(body.ses_access_key_id ?? "").trim();
      pending.push({ name: "SES_ACCESS_KEY_ID", value: v || null });
    }
    if ("ses_secret_access_key" in body) {
      const v = body.ses_secret_access_key;
      if (v !== null && typeof v !== "string")
        addError("ses_secret_access_key", "AWS secret access key must be a string (or empty to clear it).");
      else pending.push({ name: "SES_SECRET_ACCESS_KEY", value: v?.trim() || null });
    }
    // Saving a provider drops the other one's settings, so no stale credential
    // lingers (e.g. an old SMTP URL once the server moves to SES).
    const provider = String(body.email_provider ?? "").trim().toLowerCase();
    if (provider === "smtp" || provider === "ses") {
      const stale =
        provider === "ses"
          ? ["SMTP_URL"]
          : ["SES_REGION", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY"];
      for (const name of stale) {
        const i = pending.findIndex((p) => p.name === name);
        if (i >= 0) pending.splice(i, 1);
        pending.push({ name, value: null });
      }
    }
    // SES keys are a pair: one without the other would be silently dropped for
    // the IAM role at send time, so refuse it here instead.
    if ("ses_access_key_id" in body || "ses_secret_access_key" in body) {
      const next = (name: string, current: string | null) => {
        const p = pending.find((x) => x.name === name);
        return p ? p.value : current;
      };
      const hasId = !!next("SES_ACCESS_KEY_ID", config.SES_ACCESS_KEY_ID);
      const hasSecret = !!next("SES_SECRET_ACCESS_KEY", config.SES_SECRET_ACCESS_KEY);
      if (hasId !== hasSecret)
        addError(
          "ses_access_key_id",
          "Set both the AWS access key ID and secret access key, or leave both empty to use the server's IAM role.",
        );
    }
    // Shape check (local@domain.tld, no CR/LF) — these flow into nodemailer's
    // envelope, so junk and header-injection shapes stop here. Same guard the
    // config getters apply, so env-set and UI-set values gate identically.
    if ("notify_email_from" in body) {
      const v = String(body.notify_email_from ?? "").trim();
      // From is the envelope sender — exactly one address. Call out a list
      // explicitly (recipients go in the To field) rather than a generic shape
      // error, since a comma also trips isEmailish.
      if (v && v.includes(","))
        addError("notify_email_from", "From address must be a single email address — put multiple addresses in Recipients (To) instead.");
      else if (v && !isEmailish(v))
        addError("notify_email_from", "From address must be a valid email like nest@company.com.");
      else pending.push({ name: "NOTIFY_EMAIL_FROM", value: v || null });
    }
    if ("notify_email_to" in body) {
      const v = String(body.notify_email_to ?? "").trim();
      if (v && !isEmailListish(v))
        addError("notify_email_to", "Recipients must be valid emails, comma-separated (e.g. team@company.com, ops@company.com).");
      else pending.push({ name: "NOTIFY_EMAIL_TO", value: v || null });
    }
    if ("max_body_bytes" in body) {
      const n = Number(body.max_body_bytes);
      if (!Number.isFinite(n) || n < 1024 * 1024 || n > 500 * 1024 * 1024)
        addError("max_body_bytes", "Max upload size must be between 1 MB and 500 MB.");
      else pending.push({ name: "MAX_BODY_BYTES", value: String(Math.floor(n)) });
    }

    // Total-lockout guard: at least ONE sign-in method must survive the
    // PATCH — manual, PromptOwl, or a ready+enabled OIDC flow. Evaluated on
    // the effective post-PATCH state (values this request sets, falling back
    // to current config for untouched fields), so the combination is checked
    // whichever side of it is in the body. This is symmetric: it blocks
    // disabling both classic methods without SSO, AND it blocks turning off /
    // un-configuring OIDC when it's the only remaining way in.
    const effManual =
      "manual_sign_in" in body
        ? String(body.manual_sign_in ?? "").trim().toLowerCase()
        : config.MANUAL_SIGN_IN;
    const effGate =
      "promptowl_sign_in_gate" in body
        ? String(body.promptowl_sign_in_gate ?? "").trim().toLowerCase()
        : config.PROMPTOWL_SIGN_IN_GATE;
    if (effManual === "disabled" && effGate === "disabled" && !effOidcReady) {
      // Cross-field rule — key it to the field group this request touched so
      // the client focuses the tab the admin is actually editing: the SSO tab
      // when the body only changes OIDC fields, else the General tab where
      // the two classic sign-in toggles live.
      const touchedOidcOnly =
        !("manual_sign_in" in body) &&
        !("promptowl_sign_in_gate" in body) &&
        ["oidc_enabled", "oidc_issuer", "oidc_client_id", "oidc_client_secret"].some(
          (k) => k in body,
        );
      addError(
        touchedOidcOnly ? "oidc_enabled" : "manual_sign_in",
        "Cannot disable both manual and PromptOwl sign-in unless SSO (OIDC) is enabled and configured — no one would be able to log in.",
      );
    }

    // Reject the whole request if any field failed validation — apply nothing.
    // `error` is the flat message for the banner; `fieldErrors` lets the client
    // focus the offending field's tab by key (no message-text scraping).
    const errorMessages = Object.values(fieldErrors);
    if (errorMessages.length)
      return c.json(
        { error: errorMessages.join("; "), fieldErrors, settings: currentServerSettings() },
        400,
      );

    // Shape is good — now prove the email credentials actually work before we
    // persist them (wrong host/password, bad AWS keys or region). Only when this
    // PATCH touches the selected provider's fields and leaves it configured —
    // clearing them just turns the connector off, nothing to verify.
    const over = Object.fromEntries(pending.map((p) => [p.name, p.value]));
    const nextEmail = transportSettings(over);
    const emailFields =
      nextEmail?.provider === "ses"
        ? ["EMAIL_PROVIDER", "SES_REGION", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY"]
        : ["EMAIL_PROVIDER", "SMTP_URL"];
    if (nextEmail && emailFields.some((k) => k in over)) {
      const result = await verifyEmailTransport(nextEmail);
      if (!result.ok) {
        const ses = nextEmail.provider === "ses";
        const message = `${ses ? "AWS SES" : "SMTP"} connection failed: ${result.error}`;
        return c.json(
          {
            error: message,
            fieldErrors: { [ses ? "ses_region" : "smtp_url"]: message },
            settings: currentServerSettings(),
          },
          400,
        );
      }
    }

    // All valid: persist first, then mutate live env. Ordering persist-before-
    // live means a DB failure aborts before the running server changes, so a
    // 500 never leaves a live setting that was never durably stored. The store
    // is the database (durable + shared across instances) rather than a .env
    // file, which Cloud Run wipes on rebuild — see db/settings.ts.
    for (const { name, value } of pending) {
      try {
        await persistSetting(name, value);
      } catch (e) {
        return c.json(
          {
            error: `Could not persist ${name}: ${e instanceof Error ? e.message : String(e)}`,
            settings: currentServerSettings(),
          },
          500
        );
      }
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }

    // Own-provider keys go to PromptOwl, which tests each with the provider —
    // after the settings above are saved, so a refused key never strands them.
    // ponytail: one at a time, so a later refusal leaves earlier ones saved;
    // the error names the provider that failed. Without byok there is no own
    // key to clear (PromptOwl blocks it), so nothing is sent.
    const toSend = hasEntitlement("byok") ? providerKeys : [];
    let savedAny = false;
    for (const [p, v] of toSend) {
      const refused = await setOwnProviderKey(p, v);
      if (refused) {
        if (savedAny) await validateLicense({ forceFresh: true });
        return c.json(
          { error: refused, fieldErrors: { [`provider_keys.${p}`]: refused }, settings: currentServerSettings() },
          400,
        );
      }
      savedAny = true;
    }
    if (savedAny) await validateLicense({ forceFresh: true });

    return c.json({ settings: currentServerSettings() });
  });

  // GET /admin/trace — the operator audit surface: newest-first activity
  // rows (API + MCP), optional kind/nest/user/limit filters. Server admin
  // only (license admin OR super_admin) — cross-tenant data.
  app.use("/admin/trace", flexAuthMiddleware);
  app.get("/admin/trace", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can view this." }, 403);
    const limitRaw = Number(c.req.query("limit"));
    const offsetRaw = Number(c.req.query("offset"));
    const limit = Number.isFinite(limitRaw) ? limitRaw : 25;
    const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;
    const { events, total } = await listTraceEvents({
      limit,
      offset,
      kind: c.req.query("kind") as any,
      nestId: c.req.query("nest") || undefined,
      user: c.req.query("user") || undefined,
    });
    // `count` = rows on this page (back-compat); `total` = full filtered count
    // for the pager. limit/offset echo the applied window.
    return c.json({ count: events.length, total, limit, offset, events });
  });

  // ─── /admin/super-admins — grant/revoke superadmins from the UI ──────────
  // (CU-wdqcpzwf2n). The effective superadmin set is the union of three
  // sources, surfaced per row as `source`:
  //   "license" — the PromptOwl account that owns the installed license
  //               (derived live, never stored, never revocable here)
  //   "config"  — access.yaml `super_admins` (the authoritative bootstrap;
  //               revocable only by editing the file — lockout safety)
  //   "granted" — rows in the super_admins DB table (managed by these routes)
  // All three routes use the same server-admin guard as /admin/trace.
  app.use("/admin/super-admins", flexAuthMiddleware);
  app.use("/admin/super-admins/*", flexAuthMiddleware);

  app.get("/admin/super-admins", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can view this." }, 403);
    const callerEmail = (await resolveCallerEmail(c.get("userId"))).toLowerCase();

    type Row = {
      email: string;
      source: "license" | "config" | "granted";
      granted_by: string | null;
      granted_at: string | null;
      self: boolean;
    };
    // Precedence license > config > granted: an email present in several
    // sources shows its least-revocable origin (that's what governs whether
    // DELETE is allowed).
    const byEmail = new Map<string, Row>();
    const add = (row: Row) => {
      if (!byEmail.has(row.email)) byEmail.set(row.email, row);
    };

    const lic = getCurrentLicense();
    if (lic?.valid && lic.ownerEmail) {
      const email = lic.ownerEmail.toLowerCase();
      add({ email, source: "license", granted_by: null, granted_at: null, self: email === callerEmail });
    }
    for (const raw of getAccessConfig()?.super_admins ?? []) {
      const email = raw.toLowerCase();
      add({ email, source: "config", granted_by: null, granted_at: null, self: email === callerEmail });
    }
    const granted = (await getDb().all(
      "SELECT email, granted_by, granted_at FROM super_admins ORDER BY granted_at, email",
    )) as Array<{ email: string; granted_by: string; granted_at: string }>;
    for (const g of granted) {
      const email = g.email.toLowerCase();
      add({ email, source: "granted", granted_by: g.granted_by, granted_at: g.granted_at, self: email === callerEmail });
    }

    return c.json({ super_admins: [...byEmail.values()] });
  });

  app.post("/admin/super-admins", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can grant superadmin." }, 403);

    let body: { email?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || !isEmailish(email)) {
      return c.json({ error: "A valid email is required." }, 400);
    }

    // Must be an existing user on this server — a superadmin grant to a typo
    // would otherwise sit live and invisible until someone registers it.
    const user = await getDb().get(
      "SELECT id FROM users WHERE LOWER(email) = ?",
      [email],
    );
    if (!user) {
      return c.json(
        { error: "No user with this email exists on this server. Invite them as a teammate first." },
        400,
      );
    }

    const lic = getCurrentLicense();
    const isLicenseOwner =
      !!lic?.valid && lic.ownerEmail?.toLowerCase() === email;
    if (isLicenseOwner || isSuperAdmin(email)) {
      return c.json({ error: "This user is already a superadmin." }, 409);
    }
    // A superadmin is an Account Owner, and bills as a user (pricing §3).
    await assertCanAddAccountOwner(email);
    await assertCanGrant([{ userId: (user as { id: string }).id, next: "user" }]);

    const grantedBy = (await resolveCallerEmail(c.get("userId"))).toLowerCase();
    try {
      await getDb().run(
        "INSERT INTO super_admins (email, granted_by) VALUES (?, ?)",
        [email, grantedBy],
      );
    } catch (err) {
      // Concurrent-grant race: the isSuperAdmin pre-check above reads the
      // in-memory cache, so two simultaneous grants can both pass it. The PK
      // on email is the real arbiter — map its violation to the intended 409.
      const msg = err instanceof Error ? err.message : String(err);
      if (/unique|duplicate/i.test(msg)) {
        await loadGrantedSuperAdmins();
        return c.json({ error: "This user is already a superadmin." }, 409);
      }
      throw err;
    }
    await loadGrantedSuperAdmins();

    return c.json({ email, source: "granted", granted_by: grantedBy }, 201);
  });

  app.delete("/admin/super-admins/:email", async (c) => {
    if (!(await serverAdminAllowed(c)))
      return c.json({ error: "Only the server admin can revoke superadmin." }, 403);

    // Hono already percent-decodes path params — decoding again would throw
    // a URIError (→ 500) on an email containing a literal '%'.
    const email = c.req.param("email").trim().toLowerCase();
    const callerEmail = (await resolveCallerEmail(c.get("userId"))).toLowerCase();

    const lic = getCurrentLicense();
    if (lic?.valid && lic.ownerEmail?.toLowerCase() === email) {
      return c.json(
        { error: "The license admin can't be revoked — their access comes from owning the installed PromptOwl license." },
        400,
      );
    }
    // access.yaml entries are the file-authoritative bootstrap. Refusing to
    // revoke them via the API is the lockout safety: the operator always keeps
    // a set of admins that no API caller can remove.
    if (isConfigSuperAdmin(email)) {
      return c.json(
        { error: "This superadmin is defined in access.yaml and can't be revoked from here. Remove them from the file and restart the server." },
        400,
      );
    }

    const db = getDb();
    const row = await db.get(
      "SELECT email FROM super_admins WHERE LOWER(email) = ?",
      [email],
    );
    if (!row) return c.json({ error: "Not a granted superadmin." }, 404);

    // Lockout guard: you can't revoke yourself if you're the last effective
    // superadmin left (no license admin, no access.yaml entries, no other
    // DB grants) — that would leave the server with no admin at all.
    if (email === callerEmail) {
      const hasLicenseAdmin = !!lic?.valid && !!lic.ownerEmail;
      const hasConfigAdmins = (getAccessConfig()?.super_admins?.length ?? 0) > 0;
      const others = (await db.get(
        "SELECT COUNT(*) AS c FROM super_admins WHERE LOWER(email) != ?",
        [email],
      )) as { c: number };
      if (!hasLicenseAdmin && !hasConfigAdmins && others.c === 0) {
        return c.json(
          { error: "You're the last superadmin on this server — grant someone else superadmin before revoking yourself." },
          400,
        );
      }
    }

    await db.run("DELETE FROM super_admins WHERE LOWER(email) = ?", [email]);
    await loadGrantedSuperAdmins();

    return c.json({ ok: true, email });
  });

  // ─── /admin/community-sites — manage official community site connections ──
  // (CU-wdqcq0247t). CRUD lives in auth/community-sites-routes.ts, following
  // the same routes-file + app.route() convention as /teams and the
  // nest-scoped domains — auth is applied here at registration, same as them.
  app.use("/admin/community-sites", flexAuthMiddleware);
  app.use("/admin/community-sites/*", flexAuthMiddleware);
  app.route("/admin/community-sites", communitySiteRoutes);

  // ─── /admin/messages — superadmin message log ────────────────────────────
  // Every message the server sent, redacted. Superadmin ONLY (never open
  // mode, never nest admins); every read is audited. See
  // notify/message-log-routes.ts.
  app.use("/admin/messages", flexAuthMiddleware);
  app.use("/admin/messages/*", flexAuthMiddleware);
  app.route("/admin/messages", messageLogRoutes);

  // GET /stats — dashboard summary counts: nests visible to caller,
  // documents across those nests, total users on the server. Uses
  // ─── My Work — cross-nest inbox of things that need this person ──────────
  // The dashboard shows this above the nest list: reviews/approvals waiting on
  // you across every nest you can act in. Reuses the governance review queue
  // (an agent's write-back lands here too, once the runner submits governed
  // changes). flexAuth so it works in open mode and with a key.
  // Teams — global, owner-managed group primitive (not nest-scoped). Auth via
  // flexAuth; ownership + admin bypass enforced inside the service/handlers.
  //
  // GET /teams is also the browser URL for the client's Teams page
  // (ui/src/pages/app/teams/meta.ts) — unlike every other app page path
  // (my-work, settings, ...), it collides with a top-level API route. In-app
  // navigation never re-requests it (history.pushState), but a hard reload or
  // a direct link issues a real GET /teams, which teamRoutes below would
  // otherwise answer first with raw JSON instead of the app shell. Guard it
  // here, ahead of auth, the same way the SPA catch-all further down guards
  // every other path: a document navigation gets index.html; an API call
  // (no Sec-Fetch-Mode: navigate, no HTML Accept) falls through unchanged.
  app.get("/teams", async (c, next) => {
    if (isDocumentNavigation(c)) return serveIndexShell(c, next);
    return next();
  });
  app.use("/teams/*", flexAuthMiddleware);
  app.use("/teams", flexAuthMiddleware);
  app.route("/teams", teamRoutes);

  // People directory — the suggestions the add-a-person pickers autocomplete
  // against. Global like /teams (the answer spans every nest and team the
  // caller reaches), and scoped to what the caller already works with inside
  // suggestPeopleForUser — never the deployment's whole member list.
  app.use("/people/*", flexAuthMiddleware);
  app.route("/people", peopleRoutes);

  app.use("/me/*", flexAuthMiddleware);
  app.get("/me/work", async (c) => {
    const userId = c.get("userId");
    const me = await resolveCallerEmail(userId);
    const nestName = new Map<string, string>();
    for (const n of await listVisibleNests(userId))
      nestName.set(n.id, n.name ?? n.id);

    // Page the queue — 50 at a time by default — instead of pulling 200 up
    // front. limit/offset are query params (?limit=&offset=), clamped to sane
    // bounds. Scoping to the caller's visible nests up front also keeps
    // getReviewQueue from title-mapping (= filesystem-scanning) nests they
    // can't see.
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 100);
    const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
    const { requests, total } = await getReviewQueue({
      status: "pending",
      nestIds: [...nestName.keys()],
      limit,
      offset,
    });
    const toItem = (r: (typeof requests)[number]) => ({
      type: "review" as const,
      nest_id: r.nestId,
      nest_name: nestName.get(r.nestId)!,
      node_id: r.nodeId,
      title: r.title || r.nodeId,
      requested_by: r.requestedBy,
      requested_at: r.requestedAt,
      priority: r.priority,
      // Filed by an agent run (migration 060): the inbox links to its trace.
      run_id: r.runId ?? null,
    });
    // Deletion flags ride the same inbox, as a second item type: `reason` and
    // `request_id` are the extra fields resolving one needs.
    const deletions = await listDeletionRequests({
      nestIds: [...nestName.keys()],
      status: "pending",
    });
    const toDeletionItem = (r: (typeof deletions)[number]) => ({
      type: "deletion" as const,
      nest_id: r.nestId,
      nest_name: nestName.get(r.nestId)!,
      node_id: r.nodeId,
      title: r.title || r.nodeId,
      requested_by: r.requestedBy,
      requested_at: r.createdAt,
      priority: "normal" as const,
      reason: r.reason,
      request_id: r.id,
      // node_id holds a folder path / nest id for those targets, so a client
      // must not treat it as a document to open.
      target_type: r.targetType,
    });
    // Access requests (CU-wdqcq041jn) are a third item type: someone asked to
    // edit something they can only read. node_id is the document for a node
    // target, else the folder path / nest id — target_type says which.
    // Capped (500, newest first), not paginated: a person can have at most
    // MAX_PENDING_PER_NEST waiting per nest, so the pending set stays small;
    // the count below reflects what is shown.
    // Decider nests first, so only rows this caller can act on (or filed) load.
    const deciderNestIds = (
      await Promise.all(
        [...nestName.keys()].map(async (id) =>
          (await canDecideAccessRequests(id, userId)) ? id : null,
        ),
      )
    ).filter((id): id is string => id !== null);
    const [decidable, myAccessAsks] = await Promise.all([
      listAccessRequests({ nestIds: deciderNestIds, status: "pending", limit: 500 }),
      listAccessRequests({
        nestIds: [...nestName.keys()],
        requesterId: userId,
        status: "pending",
        limit: 500,
      }),
    ]);
    const toAccessItem = (r: (typeof decidable)[number]) => ({
      type: "access" as const,
      nest_id: r.nest_id,
      nest_name: nestName.get(r.nest_id)!,
      node_id: r.target_id,
      title: r.title || r.target_id,
      requested_by: r.requested_by,
      requested_at: r.created_at,
      priority: "normal" as const,
      reason: r.note ?? "",
      request_id: r.id,
      target_type: r.target_type,
      level: r.level,
      run_id: r.run_id ?? null,
    });
    type WorkItem =
      | ReturnType<typeof toItem>
      | ReturnType<typeof toDeletionItem>
      | ReturnType<typeof toAccessItem>;
    const byNewest = (a: { requested_at: string }, b: { requested_at: string }) =>
      a.requested_at < b.requested_at ? 1 : -1;
    // items = waiting on ME (someone else asked); waiting = I asked, waiting on them.
    // An editor/viewer can SEE a nest but can't approve — the "waiting on me"
    // bucket must only surface reviews this caller can actually action, else the
    // inbox nags editors/viewers to approve work they have no rights over.
    // Approve capability is a nest-level property here (a reviewer/admin role
    // anywhere on the nest, or the owner with self-approve), so resolve it ONCE
    // per distinct nest — not per request — in parallel. Bounded by nest count,
    // not queue length, so no per-item latency blowup.
    // ponytail: nest-granularity check. A reviewer scoped to only one doc/tag
    // will see that whole nest's pending items, not just their scoped docs.
    // Tighten to per-node canUserApprove if that over-inclusion ever matters.
    // Resolved for every nest the caller can SEE, not just nests that happen
    // to appear in this page of `requests` — pagination.total below needs
    // the full picture (a nest with pending reviews from someone else, on a
    // page the caller never fetched, still has to be excluded consistently).
    const others = requests.filter((r) => r.requestedBy !== me);
    const nestApprove = new Map<string, boolean>(
      await Promise.all(
        [...nestName.keys()].map(
          async (nestId): Promise<[string, boolean]> => [
            nestId,
            await canApproveInNest(nestId, me),
          ],
        ),
      ),
    );
    const items: WorkItem[] = others
      .filter((r) => nestApprove.get(r.nestId))
      .map(toItem);
    const waiting: WorkItem[] = requests
      .filter((r) => r.requestedBy === me)
      .map(toItem);

    // Waiting-on-me for the nest admins/owners who can action a flag,
    // waiting-on-others for whoever asked. Deliberately NOT folded into the
    // review queue's pagination — the flag set is small, and merging two
    // offsets into one cursor buys nothing.
    const othersDeletions = deletions.filter((r) => r.requestedBy !== me);
    // Deleting is an owner/admin call (the same tier the UI shows Delete to),
    // NOT the approve capability reviews use — resolved once per nest.
    const nestManage = new Map<string, boolean>(
      await Promise.all(
        [...new Set(othersDeletions.map((r) => r.nestId))].map(
          async (nestId): Promise<[string, boolean]> => {
            const roles = await resolveUserRoles(nestId, me);
            return [nestId, roles.includes("owner") || roles.includes("admin")];
          },
        ),
      ),
    );
    items.push(
      ...othersDeletions
        .filter((r) => nestManage.get(r.nestId))
        .map(toDeletionItem),
    );
    // Waiting on me: asks I can decide. Waiting on others: the ones I filed.
    items.push(
      ...decidable.filter((r) => r.requester_id !== userId).map(toAccessItem),
    );
    items.sort(byNewest);
    waiting.push(
      ...deletions.filter((r) => r.requestedBy === me).map(toDeletionItem),
      ...myAccessAsks.map(toAccessItem),
    );
    waiting.sort(byNewest);
    // Watcher notifications (HITL tags) ride along so the inbox is one call.
    const notifications = await listNotifications(me, { unreadOnly: true, limit: 50 });
    // `total` from getReviewQueue counts every PENDING REVIEW across every
    // nest the caller can see — full stop, regardless of who requested it or
    // whether the caller can approve it. But items/waiting only ever surface
    // a review that is either the caller's own request or one the caller can
    // actually approve (see nestApprove above); a review from someone else in
    // a nest where the caller is a bare viewer/editor never appears in either
    // bucket, yet was still counted in `total` — so the badge (which reads
    // pagination.total, see my-work/meta.ts) overcounted relative to what My
    // Work actually shows. Recompute the review portion of the total as
    // exactly (pending reviews in nests the caller can approve) + (the
    // caller's own pending reviews elsewhere) — the same two conditions
    // items/waiting are built from — via two SQL counts rather than the raw,
    // unfiltered getReviewQueue total.
    const approvableNestIds = [...nestName.keys()].filter((id) =>
      nestApprove.get(id),
    );
    const restNestIds = [...nestName.keys()].filter(
      (id) => !nestApprove.get(id),
    );
    const [{ total: approvableReviewTotal }, { total: myReviewsElsewhereTotal }] =
      await Promise.all([
        getReviewQueue({ status: "pending", nestIds: approvableNestIds, limit: 1 }),
        getReviewQueue({
          status: "pending",
          nestIds: restNestIds,
          requestedByEmail: me,
          limit: 1,
        }),
      ]);
    const reviewTotal = approvableReviewTotal + myReviewsElsewhereTotal;
    // Deletion flags and access requests ride the same two buckets (above)
    // but aren't paginated (both lists fetch every pending one), so folding in
    // however many are actually shown keeps the total exact regardless of
    // which review page this call fetched.
    const requestsShown =
      items.filter((i) => i.type === "deletion" || i.type === "access").length +
      waiting.filter((i) => i.type === "deletion" || i.type === "access").length;
    // Board cards assigned to me (open ones), across every nest I can see.
    // Best-effort: a failure here must not take the reviews inbox down with it.
    const assigned = await listAssignedTo(me, userId, nestName).catch((err) => {
      console.error("[me/work] assigned list failed", err);
      return [];
    });
    return c.json({
      items,
      waiting,
      notifications,
      assigned,
      pagination: {
        total: reviewTotal + requestsShown,
        limit,
        offset,
        has_more: offset + requests.length < total,
      },
    });
  });

  // GET /me/drafts — the documents YOU left unsubmitted, across every nest you
  // can see. Its own endpoint (and its own dashboard tab) rather than a third
  // bucket in /me/work: that inbox is already dense with reviews, deletions and
  // notifications, and drafts are a browse-and-manage list, not a queue.
  app.get("/me/drafts", async (c) => {
    const userId = c.get("userId");
    const me = await resolveCallerEmail(userId);
    const nestName = new Map<string, string>();
    for (const n of await listVisibleNests(userId))
      nestName.set(n.id, n.name ?? n.id);
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 25, 1), 100);
    const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
    const sort = c.req.query("sort") === "title" ? "title" : "updated";
    const { drafts, total } = await listMyDrafts({
      authorEmail: me,
      nestIds: [...nestName.keys()],
      limit,
      offset,
      q: c.req.query("q") ?? undefined,
      sort,
      nestNames: nestName,
    });
    return c.json({
      drafts: drafts.map((d) => ({
        nest_id: d.nestId,
        nest_name: nestName.get(d.nestId)!,
        node_id: d.nodeId,
        title: d.title,
        // Where it actually lives — the thing that was impossible to find.
        folder: folderForNode(d.nodeId),
        status: d.status,
        version: d.version,
        updated_at: d.updatedAt,
      })),
      // `total` counts drafts whose document still exists — the same set the
      // page is sliced from — so this is exact in every sort and search mode.
      pagination: { total, limit, offset, has_more: offset + limit < total },
    });
  });

  // Watcher notifications — read + mark-read (auth via the /me/* middleware).
  app.get("/me/notifications", async (c) => {
    const me = await resolveCallerEmail(c.get("userId"));
    const unreadOnly = c.req.query("unread") === "true";
    return c.json({ notifications: await listNotifications(me, { unreadOnly }) });
  });
  app.post("/me/notifications/read", async (c) => {
    const me = await resolveCallerEmail(c.get("userId"));
    const body = await c.req
      .json<{ ids?: string[] | "all" }>()
      .catch(() => ({}) as { ids?: string[] | "all" });
    await markNotificationsRead(me, body.ids === "all" ? "all" : body.ids ?? []);
    return c.json({ ok: true });
  });

  // Decline a nest invite: drop the caller's OWN collaborator row (never anyone
  // else's) and settle its invite rows. Access through a team isn't a row here,
  // so left=false — the invite still clears, the nest stays.
  app.post("/me/nests/:nestId/leave", async (c) => {
    const nestId = c.req.param("nestId");
    const me = await resolveCallerEmail(c.get("userId"));
    const db = getDb();
    const info = await db.run(
      "DELETE FROM nest_collaborators WHERE nest_id = ? AND user_id = ?",
      [nestId, c.get("userId")],
    );
    await db.run(
      `UPDATE notifications SET read_at = ? WHERE LOWER(user_email) = LOWER(?) AND nest_id = ? AND kind = 'nest_invite' AND read_at IS NULL`,
      [new Date().toISOString(), me, nestId],
    );
    // Leaving takes the leaver's personal document pins here with them
    // (CU-wdqcq02crw). Only when a collaborator row actually went: someone
    // who still reaches the nest through a team keeps their bookmarks.
    if (info.changes > 0) {
      await db.run(
        "DELETE FROM node_pins WHERE nest_id = ? AND scope = 'user' AND user_id = ?",
        [nestId, c.get("userId")],
      );
    }
    return c.json({ left: info.changes > 0 });
  });

  // flexAuthMiddleware so it works without auth in open mode and with
  // a Bearer/cookie in key mode.
  app.use("/stats", flexAuthMiddleware);
  app.get("/stats", async (c) => {
    const db = getDb();
    const userId = c.get("userId");
    const userEmail = await resolveCallerEmail(userId);

    // A nest-scoped key counts only its own nest.
    const nestScope = c.get("nestScope");
    const visibleNests = (await listVisibleNests(userId)).filter(
      (n) => !nestScope || n.id === nestScope,
    );

    // Count accessible documents across every nest the caller can see.
    // Mirrors the per-nest filterAccessible logic used by GET /nests/:id/nodes
    // so stewardship-gated docs don't inflate the total for non-stewards.
    let documents = 0;
    for (const nest of visibleNests) {
      try {
        const { storage } = await engineCache.get(nest.id);
        // Derived `— Annotations` projections are machine-maintained nodes
        // that no listing shows, so they must not be counted as documents
        // either — see isDerivedAnnotationsNode.
        const docs = (await storage.discoverDocuments()).filter(
          (d) => !isDerivedAnnotationsNode(d.id),
        );
        documents += (await filterAccessible(nest.id, userId, userEmail, docs)).length;
      } catch {
        // Nest with filesystem issue — skip; don't break the whole count.
      }
    }

    return c.json({
      nests: visibleNests.length,
      documents,
      // People only — access-key identities (CU-wdqcq0314u) aren't users.
      users: await countPeople(),
    });
  });

  app.use("/search", flexAuthMiddleware);
  // GET /search?q=&limit= — the same full-text match as GET /nests/:id/search,
  // run across every nest the caller can see. Without it a document can only be
  // found by someone who already knows which nest holds it.
  app.get("/search", async (c) => {
    const q = (c.req.query("q") || "").trim();
    if (!q) throw new ValidationError("q query parameter is required");
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 50);

    const userId = c.get("userId");
    const userEmail = await resolveCallerEmail(userId);

    type SearchHit = ReturnType<typeof toSearchHit> & {
      nest_id: string;
      nest_name: string;
    };

    // Fan out: on a cold discovery cache each nest costs a filesystem (or, on a
    // bucket-mounted deploy, a network) walk, and serially that adds up with
    // the caller's nest count. Results stay in nest order, so the cap below is
    // still deterministic.
    // ponytail: unbounded fan-out — add a concurrency limit if a caller ever
    // holds enough nests for the parallel walks to matter.
    // `readable`, not the membership-only default: a Viewer reaches a nest by
    // public visibility or a document/folder grant, with no collaborator or
    // steward row. Both paths open the nest, its node list and its per-nest
    // search — but were skipped here, so the one user who most needs global
    // search could not find documents they can plainly read. filterAccessible
    // below still narrows a public reader to approved docs and a grantee to
    // their granted docs, so widening the scan surfaces nothing new.
    // A nest-scoped key searches only its own nest.
    const nestScope = c.get("nestScope");
    const searchable = (await listVisibleNests(userId, { readable: true })).filter(
      (n) => !nestScope || n.id === nestScope,
    );
    const perNest = await Promise.all(
      searchable.map(async (nest): Promise<SearchHit[]> => {
        try {
          const { storage } = await engineCache.get(nest.id);
          const matches = matchDocuments(await discoverForSearch(storage), q);
          if (matches.length === 0) return [];
          // Per-nest stewardship filtering, same call the nest-scoped route
          // makes — a hit never leaks a doc the caller couldn't open directly.
          const accessible = await filterAccessible(nest.id, userId, userEmail, matches);
          return accessible.map((n) => ({
            ...toSearchHit(n, q),
            nest_id: nest.id,
            nest_name: nest.name ?? nest.id,
          }));
        } catch (e) {
          // One broken nest shouldn't fail the whole search — but log it, or a
          // nest that stops being searchable does so with no signal at all.
          console.error("[search] skipped nest", nest.id, e);
          return [];
        }
      }),
    );
    // Scan every nest, then rank, then cap. Each nest ranked its own matches,
    // but flattening interleaves them back into nest-creation order — so rank
    // once more across the merged list, or the cap below drops a document named
    // in the query in favour of a body mention from an older nest.
    const hits = perNest
      .flat()
      .sort((a, b) => titleScore(b.title, q) - titleScore(a.title, q));

    return c.json({
      query: q,
      count: hits.length,
      nodes: hits.slice(0, limit),
    });
  });

  // === Runner-facing run detail routes (turing) ===
  app.use("/runs/*", flexAuthMiddleware);
  app.route("/runs", runDetailRoutes);
  // Inbound trigger hooks — public by design: the unguessable token in the
  // path is the capability; presets add platform signature verification on
  // top (see workflow/hook-routes.ts).
  app.route("/hooks", hookFireRoutes);

  // === Agent entry point: /llms.txt (public manual), /index (person nest
  // index), /mcp (server-level MCP). See src/mcp/server-routes.ts. ===
  app.route("/llms.txt", llmsTxtRoutes);
  // Public published-document surface. Mounted BEFORE the SPA catch-all and
  // OUTSIDE the /nests auth chain so /p/<slug> is reachable with no account
  // (public mode) or behind its own gate (email/code/invite).
  app.route("/p", publishRenderRoutes);
  // Same three-way auth as /mcp: an OAuth access token, an MCP ticket, or a
  // cnst_ key. /index is the grounded nest list the MCP tools read from, so a
  // token that works on one must work on the other.
  app.use("/index", mcpOAuthBearer);
  app.route("/index", nestIndexRoutes);
  app.use("/mcp", mcpOAuthChallenge);
  app.use("/mcp", mcpOAuthBearer);
  app.route("/mcp", serverMcpRoutes);

  // Named systems (CU-wdqcq0538g). Admin-gated in the service layer
  // (owner/admin of the nests involved); a system or headless key never gets
  // here (the nest-scope guard fences those out).
  app.use("/systems", flexAuthMiddleware);
  app.use("/systems/*", flexAuthMiddleware);
  app.route("/systems", systemRoutes);

  // === All /nests routes ===
  const nestsApp = new Hono<AuthEnv>();

  // Use flexible auth: open mode = no key needed, key mode = key required.
  // Three per-nest paths additionally honor PromptOwl service tickets —
  // POST :id/context (deterministic retrieval for prompt data sources),
  // GET :id/nodes (doc listing for the source picker), and :id/mcp (the
  // per-nest MCP transport, so a PromptOwl block granted read & write on
  // one nest can reach the write tools that deliberately don't exist on
  // the server-level /mcp). Safe for the same reason cnst_ keys are: the
  // permission gate below applies to tickets too, and every mutating tool
  // re-checks its own permission inside runTool. Everything else under
  // /nests still requires real credentials.
  nestsApp.use("*", async (c, next) => {
    const parts = nestPathParts(c.req.path);
    const ticketEligible =
      parts.length === 2 &&
      ((c.req.method === "POST" && parts[1] === "context") ||
        (c.req.method === "GET" && parts[1] === "nodes") ||
        parts[1] === "mcp");
    return ticketEligible
      ? flexAuthWithPromptowlTicket(c, next)
      : flexAuthMiddleware(c, next);
  });

  // Why a write is refused on a read-only server — suspended by PromptOwl, or
  // no valid license past the Free tier — worded for who asked: admins get the
  // reason and who to talk to, everyone else one neutral line. null = writes
  // are allowed (licensed, or unlicensed with FREE_TIER_MAX_USERS or fewer
  // people; see writesAllowed in auth/free-tier.ts).
  const readOnlyDenial = async (
    userId: string,
  ): Promise<{ error: string; extra: Record<string, unknown> } | null> => {
    const admin = () => canSeeLicenseDetail(userId);
    if (isSuspended()) {
      if (!(await admin())) return { error: NEUTRAL_READ_ONLY, extra: { read_only: true } };
      const lic = getCurrentLicense();
      return {
        error: "Server suspended by PromptOwl",
        extra: {
          reason: getSuspensionReason(),
          contact: (lic?.contact ?? DEFAULT_LICENSE_CONTACT).email,
          contact_url: (lic?.contact ?? DEFAULT_LICENSE_CONTACT).url,
        },
      };
    }
    const offlineSince = getOfflineLock();
    if (offlineSince) {
      if (!(await admin())) return { error: NEUTRAL_READ_ONLY, extra: { read_only: true } };
      return {
        error: "License check overdue",
        extra: { reason: offlineLockMessage(offlineSince), offline_since: offlineSince },
      };
    }
    if (await writesAllowed()) return null;
    const lic = getCurrentLicense();
    if (!(await admin())) return { error: NEUTRAL_READ_ONLY, extra: { read_only: true } };
    // licenseTerms carries the machine reason code; expose it as
    // license_reason so it doesn't clobber the human-readable reason.
    const { reason: licenseReason, ...terms } = licenseTerms(lic);
    return {
      error: "License required",
      extra: {
        ...terms,
        license_reason: licenseReason,
        reason:
          lic?.reason === "expired"
            ? "This server's PromptOwl license has ended, so it is read-only until it is renewed. Nothing has been deleted."
            : FREE_TIER_EXCEEDED_MESSAGE,
        setup_url: "/setup",
      },
    };
  };

  // Access control for nest-scoped routes
  nestsApp.use("*", async (c, next) => {
    const parts = nestPathParts(c.req.path);
    // Nest-level writes (create, rename, delete: /nests, /nests/:id) and the
    // unsynced-folder actions skip the per-nest checks below, but a read-only
    // server must refuse them too.
    if ((parts.length < 2 || parts[0] === "unsynced") && c.req.method !== "GET") {
      const denial = await readOnlyDenial(c.get("userId"));
      if (denial) return c.json({ error: denial.error, ...denial.extra }, 503);
    }
    if (parts.length < 2) return next();

    // Experimental document pins (CU-wdqcq02crw): while the switch is off the
    // routes do not exist — 404 before the license gate, the permission merge
    // or the nest lookup, so "off" answers the same whoever asks. Exact
    // resource segment; documents live under /nodes, never here.
    const isDocPinsPath = parts[1] === "pins";
    if (isDocPinsPath && !config.EXPERIMENTAL_DOC_PINS) {
      return c.json({ error: "Not found" }, 404);
    }

    // "unsynced" is a server-admin namespace under /nests, not a nest id.
    // Without this bypass parts[0]="unsynced" is treated as a nest id and the
    // permission resolver 404s every call with "Nest not found". Its own
    // route handlers run the admin-gate check.
    if (parts[0] === "unsynced") return next();

    const nestId = parts[0];
    const userId = c.get("userId");
    const nestScope = c.get("nestScope");

    // MCP transport (POST /nests/:id/mcp): the client speaks JSON-RPC, so a
    // plain `{error}` JSON body surfaces in the client UI as a generic
    // "no tools found" / connection failure with no explanation. Wrap gate
    // denials for this path in a JSON-RPC error envelope (echoing the
    // request id when parseable) so the client shows WHY the connection
    // failed — wrong key scope, missing license, no access.
    const isMcpTransport = parts.length === 2 && parts[1] === "mcp";
    // Archive and restore are gated in the route by requireNestCaretaker (the
    // owner, or the license admin as caretaker of the commons) — strictly
    // narrower than 'write'. Both the open-mode branch and the tier block below
    // exempt them, because an archived nest caps every caller at 'read' and a
    // 'write' requirement here would strand a nest that could never be
    // restored.
    //
    // DELETE /nests/:id is NOT listed: it is `parts.length === 1`, which the
    // guard above returns on, so it never reaches this middleware at all — its
    // only gate is requireNestCaretaker, archived or not.
    const isNestLifecycleAction =
      parts.length === 2 &&
      c.req.method === "POST" &&
      (parts[1] === "archive" || parts[1] === "restore");
    // Pinning is read-tier: a pin is the caller's own bookmark, changes nothing
    // about the nest and is visible to nobody else, so anyone who can open the
    // nest may pin it — a viewer most of all, since they are the likeliest to
    // be watching a handful of nests they cannot edit. The handler still
    // refuses a caller with no access at all, so this is not an existence
    // oracle for nest ids. Declared up here because the grant-only branch below
    // needs it too, and that runs before the tier block.
    const isPinAction = parts.length === 2 && parts[1] === "pin";
    const deny = async (
      status: 403 | 404 | 503,
      error: string,
      extra?: Record<string, unknown>,
    ) => {
      if (!isMcpTransport) return c.json({ error, ...extra }, status);
      // Reading the body here is safe even though the MCP transport also
      // consumes it downstream: Hono caches the parsed body on the request,
      // and on this path we return WITHOUT calling next() anyway. If the
      // body-reading strategy upstream ever changes, id echoing degrades to
      // null — never a thrown error.
      let id: string | number | null = null;
      try {
        id = (await c.req.json())?.id ?? null;
      } catch {
        /* unparseable body — id stays null */
      }
      // Fold the human-facing `reason` into the message — the envelope's
      // `message` string is all most MCP clients display.
      const message =
        typeof extra?.reason === "string" ? `${error} — ${extra.reason}` : error;
      return c.json(
        { jsonrpc: "2.0", id, error: { code: -32000, message } },
        status,
      );
    };

    if (nestScope && nestScope !== nestId) {
      return deny(
        403,
        `API key not authorized for this nest — this key is scoped to nest "${nestScope}". Use that nest's MCP URL, or mint a user-level key in the Connect dialog.`,
      );
    }

    // Kill switch or offline limit: block writes but allow reads
    // Only admins hear why; everyone else gets the neutral read-only line.
    if ((isSuspended() || getOfflineLock()) && c.req.method !== "GET") {
      const denial = await readOnlyDenial(userId);
      if (denial) return deny(503, denial.error, denial.extra);
    }

    // License gate: block writes until a valid PromptOwl key is
    // installed via /license/install — unless the server is within the Free
    // tier (readOnlyDenial → writesAllowed). Reads stay open for plain
    // node/nest browsing — but governance endpoints (stewards,
    // review-queue, approve/reject, version history, capability
    // checks) are admin features and stay locked regardless of HTTP
    // method.
    {
      const path = c.req.path;
      // `/comments` and `/activity` must be matched as complete trailing route
      // segments, NOT substrings — a node id is `nodes/<slug>` and a title like
      // "Comments Draft" yields slug `comments-draft`, whose path contains the
      // substring `/comments`. Anchor to the actual comment/activity route
      // shapes so a node slug can't masquerade as a governance action (see the
      // matching guard in the permission block below).
      const isCommentPath =
        /\/comments$/.test(path) ||
        /\/comments\/[^/]+\/resolve$/.test(path);
      // The task log is a slice of the same timeline.
      const isActivityPath = /\/(activity|task-log)$/.test(path);
      // The activity feed serves the review queue's rows under another URL
      // (/nests/:id/feed?filter=changes), so it must sit behind the same
      // license gate as /review-queue. Match the exact nest-scoped route
      // shape via the already-split path segments — NOT includes("/feed"),
      // which a node slug like nodes/product-feed would false-positive
      // (parts = [nestId, "feed"] only for the real feed route).
      const isFeedPath = parts.length === 2 && parts[1] === "feed";
      // The deletion-request queue is a governance view like /review-queue.
      // Exact segment match (not includes) so a node slugged
      // "deletion-requests" can't drag plain node reads behind the gate.
      const isDeletionQueuePath =
        parts.length === 2 && parts[1] === "deletion-requests";
      // The agent-activity stream and its undo (CU-wdqcq0314v) are governance
      // views over version history. Exact segments, so a node slugged
      // "agent-activity" stays an ordinary node read.
      const isAgentActivityPath =
        parts[1] === "agent-activity" &&
        (parts.length === 2 || (parts.length === 3 && parts[2] === "undo"));
      const isGovernance =
        path.includes("/stewards") ||
        path.includes("/review-queue") ||
        path.includes("/versions") ||
        path.includes("/reviews") ||
        path.includes("/submit-review") ||
        path.includes("/cancel-review") ||
        path.includes("/approve") ||
        path.includes("/reject") ||
        path.includes("/can-access") ||
        path.includes("/can-approve") ||
        path.includes("/can-edit") ||
        // Push Confirmation Gate — the per-key allowlist is a governance
        // surface, licensed like /review-queue (even on GET). /pending-pushes
        // is deliberately NOT here: see isPushRelease below.
        path.includes("/push-allowlist") ||
        isCommentPath ||
        isActivityPath ||
        isFeedPath ||
        isDeletionQueuePath ||
        isAgentActivityPath ||
        // Document pins (CU-wdqcq02crw) are a curation surface, licensed like
        // the governance views even on GET. Exact segment (parts[1]).
        parts[1] === "pins";
      // Releasing a held push is exempt from the license gate — listing,
      // reading, confirming and rejecting alike. POST /publish is unlicensed,
      // so on a gated nest a lapsed license would hold every push at 202 and
      // then 503 the only routes that can let them through: the nest stops
      // accepting writes with no in-product way back. The gate itself is what
      // the license buys; draining what it already holds must never be.
      const isPushRelease = path.includes("/pending-pushes");
      const needsLicense =
        !isPushRelease && (c.req.method !== "GET" || isGovernance);
      if (needsLicense && !getCurrentLicense()?.valid) {
        const denial = await readOnlyDenial(userId);
        if (denial) return deny(503, denial.error, denial.extra);
      }
    }

    // In open mode, everyone gets owner-level access — but archiving is not an
    // access rule, it is a property of the nest, so it binds here too. This
    // branch returns before the permission merge below, so the cap that makes
    // an archived nest read-only never reaches it; without this check, open
    // mode (the local/LAN posture where an MCP agent is most likely to be
    // pointed straight at a nest) could still write to a nest that was
    // archived precisely to stop that.
    //
    // One indexed lookup on the hot path, and the full rule only for the rare
    // archived nest: everything but a GET is refused, except the lifecycle
    // actions that must survive archiving (restore, delete).
    if (config.AUTH_MODE === "open") {
      const archived = await isNestArchived(nestId);
      if (archived) {
        if (isMcpTransport) return deny(404, "Nest not found");
        if (c.req.method !== "GET" && !isNestLifecycleAction) {
          return deny(
            403,
            "This nest is archived, so it is read-only. Restore it to make changes.",
            { archived: true },
          );
        }
      }
      c.set("nestPermission", archived ? "read" : "owner");
      return next();
    }

    // One fetch: the permission merge AND whether the caller holds any share
    // grant here, which the grant branches below read off this row instead of
    // re-querying once per branch.
    const access = await resolveNestAccess(nestId, userId);
    const permission = access.permission;

    // An archived nest does not exist as far as agents are concerned. It is
    // already absent from every MCP listing (the list helpers skip archived
    // rows), and this closes the by-id path: a pinned nest id or a nest-scoped
    // API key goes dead until the nest is restored. Humans still read it in the
    // web UI — this is the MCP transport only.
    if (access.archived && isMcpTransport) {
      return deny(404, "Nest not found");
    }

    // Document/folder share grant: a caller BELOW nest access may still reach
    // a specific granted node (or a bare nest read, so a shared-doc deep link
    // loads the nest shell). Scoped strictly to the granted node's own
    // routes — a grant on one doc never opens the rest of the nest.
    // targetTail is the path under /nodes/, i.e. the node id + any subresource
    // (versions, comments, annotations) — the same prefix a grant covers.
    // Retrieval/query routes (context, query, search, export) are READ-tier:
    // the body is a query, not a mutation — same class as GET /search &
    // /export. A doc/folder grantee may use them; the handler scopes every
    // result to their granted docs via filterAccessible, exactly like the node
    // list. Deliberately NOT graph/publish (nest-write) or changes/overview
    // (whole-nest views). parts.length===2 pins the exact /nests/:id/<route>.
    const isReadQuery =
      parts.length === 2 &&
      ["context", "query", "search", "export", "chat"].includes(parts[1]);
    // Checking a title or folder against the structure rules reads, never
    // writes: viewers check names in the new-document form. The handler asks
    // for owner/admin itself when the body carries draft rules.
    const isStructureCheck =
      parts.length === 3 && parts[1] === "structure" && parts[2] === "check";

    // CAPABILITY GATE (read-only keys). A key minted read-only must never reach
    // a write or governance mutation on ANY nest — enforced HERE, server-side,
    // not by UI filtering. A "pure read" is a GET, a read-tier query POST
    // (context/query/search/export, above), or the MCP transport (always POST;
    // its per-tool capability gate in mcp/tools.ts blocks the write tools while
    // leaving reads working). Everything else — node create/update/delete,
    // approve/reject/submit-review, comments, annotations, deletion requests,
    // stewards, sharing, sync — is a mutation and is denied. This sits BEFORE
    // the per-route permission resolution below because a read-only credential
    // is denied regardless of how much nest permission the underlying user has.
    // Named system keys never touch the nest's people/settings/credential/
    // automation surfaces, even when their collaborator standing would allow
    // it (CU-wdqcq0538g).
    if (
      c.get("principalKind") === "system" &&
      SYSTEM_DENIED_RESOURCES.has(parts[1])
    ) {
      return deny(
        403,
        "A system key can't manage this nest's people, settings, publishing, keys or automation.",
      );
    }

    if (c.get("keyCapability") === "read") {
      const isPureRead =
        c.req.method === "GET" ||
        // chat can post a mention comment and spends model credits — not a read.
        (isReadQuery && parts[1] !== "chat") ||
        isMcpTransport;
      if (!isPureRead) {
        return deny(
          403,
          "This API key is read-only and cannot perform write or governance actions.",
          {
            reason:
              "Mint a read-write key (or use a session) for changes. Read-only keys may only read, query, search, and export.",
            capability: "read",
          },
        );
      }
    }

    // MCP transport is read-tier (isMcpTransport, declared above with the
    // deny helper): the Streamable HTTP protocol is ALWAYS POST — even
    // initialize and tools/list — so the generic non-GET 'write' bump below
    // must skip it or read-only collaborators lose the whole MCP surface.
    // Every mutating tool re-checks its own permission inside runTool
    // (create/edit via stewardship, approve/reject via canUserApprove,
    // stewards/sharing/sync via their own admin checks).

    let grantRole: "read" | "write" | null = null;
    let grantNestVisible = false;
    if (permission === "none") {
      if (parts[1] === "nodes" && parts.length >= 3) {
        let targetTail = parts.slice(2).join("/");
        try {
          targetTail = decodeURIComponent(targetTail);
        } catch {
          /* malformed escape — resolve as-is */
        }
        grantRole = await resolveNodeGrant(nestId, userId, targetTail);
      } else if (parts.length === 1 && c.req.method === "GET") {
        // GET /nests/:id (bare) — let a grantee see the nest name so a shared
        // link resolves; the node LIST stays filtered to their grants.
        grantNestVisible = access.hasGrant;
      } else if (
        parts[1] === "nodes" &&
        parts.length === 2 &&
        c.req.method === "GET"
      ) {
        // GET /nests/:id/nodes (the list) — allowed for grantees; the handler
        // (listNodesForCaller) filters to only the nodes they're granted.
        grantNestVisible = access.hasGrant;
      } else if (isReadQuery) {
        // Retrieval routes — a grantee may query/search/context/export; the
        // handler's filterAccessible scopes every result to their grants, so
        // they can never read past what they were shared (same as the list).
        grantNestVisible = access.hasGrant;
      } else if (
        parts[1] === "access-requests" &&
        ((parts.length === 2 && c.req.method === "POST") ||
          (parts.length === 3 && parts[2] === "mine" && c.req.method === "GET"))
      ) {
        // Asking for more access (CU-wdqcq041jn), for someone who reaches this
        // nest only through a document or folder share — the person a refused
        // write most often stops. Filing and reading back their OWN request is
        // all this opens; the service 404s a target they can't see, and
        // deciding stays owner/admin-only in the handler.
        grantNestVisible = access.hasGrant;
      } else if (parts[1] === "pins") {
        // Document pins (CU-wdqcq02crw), for someone who reaches this nest only
        // through a document or folder grant: the list is narrowed to the
        // documents they can read (filterAccessible), a personal pin needs read
        // access to its document, and editorial writes are refused in the
        // handler — so this opens nothing past their grants.
        grantNestVisible = access.hasGrant;
      } else if (isPinAction) {
        // Pinning, for someone who reaches this nest only through a document or
        // folder grant. They see the nest on their dashboard, so they see its
        // pin control — and a control that 404s is worse than no control. The
        // pin touches nothing they can't already reach: it is their own
        // bookmark on a nest already listed for them, and it grants no wider
        // read. effectiveAccess in nests/routes.ts already resolves a grantee
        // to "read" for exactly this class of route; this is the middleware
        // half of that same rule.
        grantNestVisible = access.hasGrant;
      } else if (
        (parts[1] === "definitions" || parts[1] === "fields") &&
        parts.length === 2 &&
        c.req.method === "GET"
      ) {
        // GET /nests/:id/definitions — the nest's glossary. Unlike node
        // routes this isn't per-document content to scope with
        // filterAccessible, it's shared vocabulary a doc/folder grantee
        // needs to make sense of whatever they were granted (e.g. a term
        // referenced by their node). Same visibility rule as the bare nest
        // read and node list: any grant on this nest is enough to read it.
        grantNestVisible = access.hasGrant;
      }
      if (!grantRole && !grantNestVisible) {
        // Same message for "doesn't exist" and "no access" — existence oracle.
        return deny(404, "Nest not found", {
          reason:
            "The nest id may be wrong, or these credentials have no access to it. Ask the nest owner to share the nest with you, then reconnect.",
        });
      }
    }

    // A nest VIEWER can hold a write share on one document or folder (an
    // approved access request is exactly that). The share has to count on that
    // node's write routes too, or the grant would read as access and refuse
    // every edit. Reads don't need it — the viewer already reads the nest.
    if (
      permission === "read" &&
      !grantRole &&
      access.hasGrant &&
      parts[1] === "nodes" &&
      parts.length >= 3 &&
      c.req.method !== "GET"
    ) {
      let targetTail = parts.slice(2).join("/");
      try {
        targetTail = decodeURIComponent(targetTail);
      } catch {
        /* malformed escape — resolve as-is */
      }
      grantRole = await resolveNodeGrant(nestId, userId, targetTail);
    }

    let required: NestPermission = "read";
    const path = c.req.path;
    // Stewardship endpoints run their own per-row permission checks
    // (steward role). Bumping every non-GET to "write" here blocks
    // reviewers — who legitimately have read-only collaborator access
    // plus a reviewer steward row — before their handler can even
    // decide. Let read-permission users through for these paths and
    // trust the handler.
    // The batch approve/reject belongs here for the same reason: it is a
    // wrapper over those per-document decisions and re-checks every item
    // through them. Exact trailing segment, so a node slug can't reach it.
    const isStewardActionPath =
      path.includes("/approve") ||
      path.includes("/reject") ||
      path.includes("/submit-review") ||
      path.includes("/cancel-review") ||
      /\/review-queue\/bulk$/.test(path) ||
      (parts.length === 3 && parts[1] === "agent-activity" && parts[2] === "undo");
    // Confirm/reject a held push (Push Confirmation Gate) is admitted at
    // read-tier so a read-only reviewer steward can decide it; the handler's
    // own canConfirmPush is the real gate (submitter OR reviewer/owner/admin).
    // (reject already matches isStewardActionPath's /reject; confirm needs this.)
    const isPushDecisionPath =
      /\/pending-pushes\/[^/]+\/(confirm|reject)$/.test(path);
    // Hosted-artifact annotations are a read-tier collaboration action:
    // anyone who can SEE the artifact (notably read-only reviewers — the people
    // most likely to annotate) may open a thread, reply, resolve or reopen.
    // Handlers re-check node read-access; don't bump these POSTs to "write".
    //   POST …/annotations                        → create thread
    //   POST …/annotations/:id/{comments,resolve,reopen}
    const isAnnotationAction =
      /\/annotations$/.test(path) ||
      /\/annotations\/[^/]+\/(comments|resolve|reopen)$/.test(path);
    // Commenting is a read-tier collaboration action: anyone who can see the
    // node may leave or resolve a comment. Don't bump these POSTs to "write"
    // (that would block read-only reviewers — the people most likely to
    // comment). The handler/service own any finer-grained rules.
    //
    // Match `/comments` as a complete trailing route segment, NOT a substring:
    // a node id is `nodes/<slug>` and a title like "Comments Draft" → slug
    // `comments-draft` → path `…/nodes/comments-draft` contains `/comments`.
    // A substring match left `required` at "read", letting a read-only
    // collaborator PATCH/DELETE any node whose slug starts with "comments".
    const isCommentAction =
      /\/comments$/.test(path) ||
      /\/comments\/[^/]+\/resolve$/.test(path);
    // Flagging a node for deletion is admitted at read-tier HERE so the
    // handler can answer 404-then-403 in the right order (a caller who can't
    // see the node must not learn it exists). The real gate is the handler's
    // own editor check — canRequestDeletion in access-guard.ts — so a viewer
    // gets through this line and is refused there. Resolving the flag
    // (/deletion-requests/:id/{delete,decline}) is NOT here — it stays at
    // 'write', the same tier DELETE /nodes/:id requires.
    // Withdrawing your OWN request (/deletion-requests/:id/withdraw) is also
    // admitted at read-tier — you don't need write access to undo your own
    // flag. The handler validates ownership (withdrawnBy === requestedBy).
    const isDeletionRequestAction =
      /\/request-deletion$/.test(path) ||
      /\/deletion-requests\/[^/]+\/withdraw$/.test(path);
    // Asking for access is what a viewer does (CU-wdqcq041jn), so the whole
    // /access-requests surface sits at read tier. Approve/deny are refused in
    // the handler for anyone but the owner, a nest admin or the server admin.
    // Exact resource segment, so a node slugged "access-requests" stays a node.
    const isAccessRequestAction = parts[1] === "access-requests";
    // Custom field definitions: a nest-wide reviewer steward may define them
    // while holding only read collaborator access, so writes are admitted at
    // read tier and gated in the handler (assertCanManageFields), which also
    // refuses an archived nest. Exact resource segment.
    // ANY route added under /fields inherits this bypass — every handler in
    // src/nests/field-routes.ts must call assertCanManageFields itself
    // (test/custom-fields.test.ts pins read collaborators, editor stewards
    // and tag-scoped reviewers at 403).
    const isFieldDefinitionAction = parts[1] === "fields";
    // isNestLifecycleAction (archive/restore) is defined above, next to
    // isMcpTransport — the open-mode branch needs it too, and that branch runs
    // before this point.
    // The steward roster — list, assign, remove, sync — is restricted to the
    // server (license) admin plus the nest owner/admin collaborators, so an
    // owner can delegate vault people-management by granting admin. All
    // methods on /nests/:id/stewards are gated. The node-level resolve route
    // (/nodes/:id/stewards) stays readable so the editor UI can resolve a
    // caller's per-node role.
    const isStewardRoster =
      path.includes("/stewards") && !path.includes("/nodes/");
    // Gate on the caller's UNCAPPED standing (rawPermission folds the
    // license/super admin into "admin", so owner/admin covers server admin,
    // nest owner, and admin collaborators — same rule as canManageStewards).
    // The archive cap would otherwise turn the owner into "read" here and
    // tell them they lack a permission they hold; an archived nest keeps its
    // roster readable and refuses changes as archived, like everything else.
    if (
      isStewardRoster &&
      access.rawPermission !== "owner" &&
      access.rawPermission !== "admin"
    ) {
      return c.json(
        {
          error:
            "You don't have permission to manage stewards. Only a nest admin, the nest owner, or the server admin can do this.",
        },
        403,
      );
    }
    if (isStewardRoster && access.archived && c.req.method !== "GET") {
      return deny(
        403,
        "This nest is archived, so it is read-only. Restore it to change stewards.",
        { archived: true },
      );
    }
    // Match the resource as an exact path segment, NOT a substring: a node id
    // is derived from the doc title (e.g. "Collaborators Guide" → slug
    // `collaborators-guide`), so a substring `path.includes("/collaborators")`
    // would wrongly gate `…/nodes/collaborators-guide` as a collaborators route
    // and 403 a write user editing that doc. parts[1] is the resource segment.
    const resource = parts[1];
    if (
      resource === "visibility" ||
      resource === "reader-mode" ||
      resource === "branding" ||
      // headless (CU-wdqcq0314u): publishing API-only and minting access keys
      // decide who can read the nest — the same owner/admin tier as visibility.
      resource === "headless"
    ) {
      // reader-mode: the nest owner/admin collaborator AND the server admin
      // may configure it — this "admin" tier already covers both
      // (resolveNestPermission maps the server/super admin to "admin" too),
      // so the handler needs no further hard-gating past this middleware.
      // branding (CU-wdqcq02ptm): same owner/admin tier; its handler adds
      // the server-admin-only hide_powered_by check.
      required = "admin";
    } else if (resource === "collaborators") {
      // Viewing the roster (GET) and inviting (POST) are open to write+
      // collaborators: the Collaborators tab loads the roster and lets editors
      // bring people in — you no longer need to be a nest admin. Kept at write
      // (not read) so a public nest's read tier can't enumerate member emails.
      // The escalation cap — you can't grant above your own level — is enforced
      // in addCollaborator. Changing or removing existing collaborators
      // (PATCH/DELETE) stays admin-only, per the ticket's governance rule.
      required = c.req.method === "GET" || c.req.method === "POST"
        ? "write"
        : "admin";
    } else if (resource === "teams") {
      // Team shares change who can reach the nest. Listing exposes member
      // emails (like the collaborator roster) → 'write'; sharing/unsharing a
      // whole team (which may include admin-role members) → 'admin'.
      required = c.req.method === "GET" ? "write" : "admin";
    } else if (parts[1] === "hooks") {
      // Hook rows carry trigger capability (the token fires runs, which is
      // a write-tier action) — reading the list must not be a read-tier
      // privilege escalation.
      required = "write";
    } else if (
      c.req.method !== "GET" &&
      !isStewardActionPath &&
      !isPushDecisionPath &&
      !isCommentAction &&
      !isDeletionRequestAction &&
      !isAccessRequestAction &&
      !isFieldDefinitionAction &&
      !isNestLifecycleAction &&
      !isPinAction &&
      // Document pins: personal pins need only read access; editorial writes
      // are gated in the handler (assertCanCurate) — a nest-wide reviewer
      // steward may hold only read collaborator access.
      !isDocPinsPath &&
      !isAnnotationAction &&
      !isReadQuery &&
      !isStructureCheck &&
      !isMcpTransport
    ) {
      required = "write";
    }

    // Editor steward bypass for nest-read callers: PATCH/DELETE (and the
    // POST .../revert and .../move actions) allowed when an editor row
    // covers the node; POST to create a node allowed only for nest-scope
    // editors.
    const isNodeAction =
      c.req.method === "POST" &&
      parts.length >= 4 &&
      (parts[parts.length - 1] === "revert" ||
        parts[parts.length - 1] === "move");
    let stewardEditorBypass = false;
    // `!access.archived`: the cap leaves every caller at "read", which is
    // exactly the shape this bypass fires on — without it, archiving would
    // ARM the bypass for write collaborators who also hold an editor row.
    if (
      required === "write" &&
      permission === "read" &&
      !access.archived &&
      parts[1] === "nodes"
    ) {
      const userEmail = await resolveCallerEmail(userId);
      if (
        parts.length >= 3 &&
        (c.req.method === "PATCH" || c.req.method === "DELETE" || isNodeAction)
      ) {
        // Action paths carry a trailing /revert or /move segment — drop it
        // to recover the node id; PATCH/DELETE take the id as-is.
        const idParts = isNodeAction ? parts.slice(2, -1) : parts.slice(2);
        const rawNodeId = idParts.join("/");
        let nodeId = rawNodeId;
        try {
          nodeId = decodeURIComponent(rawNodeId);
        } catch {
          /* malformed escape */
        }
        const resolved = await resolveStewardsForNode(nestId, nodeId);
        stewardEditorBypass = resolved.some(
          (r) =>
            r.steward.userEmail.toLowerCase() === userEmail.toLowerCase() &&
            r.steward.role === "editor",
        );
      } else if (
        c.req.method === "POST" &&
        // POST /nodes (create) and POST /nodes/pdf (PDF upload — a create, or
        // a new version of a pdf node) share the nest-scope editor rule.
        (parts.length === 2 || (parts.length === 3 && parts[2] === "pdf"))
      ) {
        // Empty nodeId: doc/tag branches won't match; nest branch returns all.
        const resolved = await resolveStewardsForNode(nestId, "");
        stewardEditorBypass = resolved.some(
          (r) =>
            r.steward.userEmail.toLowerCase() === userEmail.toLowerCase() &&
            r.steward.role === "editor" &&
            r.steward.scope === "nest",
        );
      }
    }

    // A share grant on the targeted node counts toward the requirement, but
    // only for that node's routes (grantRole is null elsewhere) and never for
    // nest-management routes. grantNestVisible (bare nest read / filtered list)
    // satisfies the read requirement without conferring write.
    const grantLevel = grantRole
      ? permissionLevel(grantRole)
      : grantNestVisible
        ? permissionLevel("read")
        : 0;
    const effectiveLevel = Math.max(permissionLevel(permission), grantLevel);

    if (
      !stewardEditorBypass &&
      effectiveLevel < permissionLevel(required)
    ) {
      // The archive cap is what refused this, not the caller's standing —
      // an owner told "your permission: 'read'" on their own nest would go
      // looking for a grant that can't help. Name the real reason, with the
      // same {archived:true} marker the open-mode branch sends.
      if (access.archived && permissionLevel(access.rawPermission) >= permissionLevel(required)) {
        return deny(
          403,
          "This nest is archived, so it is read-only. Restore it to make changes.",
          { archived: true },
        );
      }
      // Someone who can see the target but not change it may ask for the
      // access instead of stopping here (CU-wdqcq041jn). Writes only: a GET
      // held at write tier (the collaborator roster, hooks) is a read the UI
      // makes on its own, not something the person tried to change, and
      // admin-tier routes (visibility, roles) aren't something to request.
      const hint =
        required === "write" &&
        c.req.method !== "GET" &&
        effectiveLevel >= permissionLevel("read")
          ? await accessRequestHint({
              nestId,
              userId,
              target: writeTargetForPath(nestId, parts, c.req.method),
            })
          : null;
      return deny(
        403,
        hint
          ? `You don't have edit access here. Your permission: '${permission}'. You can request write access from the nest owner or an admin (POST /nests/${nestId}/access-requests).`
          : `You don't have access to perform this action on this nest. Required permission: '${required}', your permission: '${permission}'. Ask the nest owner or a server admin to grant you ${required} access.`,
        {
          required_permission: required,
          your_permission: permission,
          ...hint,
        },
      );
    }

    // Downstream sees the grant role when it outranks the nest permission — a
    // caller acting purely via a grant (nest permission "none"), or a viewer
    // holding a write share on this node — so node handlers treat them
    // correctly.
    let effectivePermission: NestPermission =
      grantRole && permissionLevel(grantRole) > permissionLevel(permission)
        ? grantRole
        : permission;
    // A read-only key caps the effective permission at 'read', so any handler
    // that keys off nestPermission (and GET /nests/:id, which reports it to the
    // UI) sees the truth: this credential cannot write here. Defense in depth —
    // the pure-read gate above already blocked the mutation; this keeps the
    // reported permission honest and closes any handler that gates on it.
    if (
      c.get("keyCapability") === "read" &&
      permissionLevel(effectivePermission) > permissionLevel("read")
    ) {
      effectivePermission = "read";
    }
    c.set("nestPermission", effectivePermission);
    return next();
  });

  // SECURITY: single containment chokepoint for every node-id-bearing route
  // across the three routers mounted below (governance node ops, annotations,
  // node CRUD). Node ids become filesystem paths in the engine's storage layer
  // (join(nestRoot, id + ".md"), no containment of its own), so a `../` id must
  // be rejected before ANY handler turns it into a read/write/delete — otherwise
  // a caller scoped to one nest reaches another tenant's files. Centralized here
  // (not per-route) so a newly added node route can't silently forget the guard.
  // The greedy {.+} captures the whole remainder incl. any suffix (/versions,
  // /annotations/:id/comments, …); assertSafeNodeId trips on a `..` segment
  // anywhere in it. Non-node routes (create/list POST|GET /nodes) don't match.
  nestsApp.use("/:nestId/nodes/:nodeId{.+}", async (c, next) => {
    assertSafeNodeId(c.req.param("nodeId")!);
    return next();
  });

  // GET /nests/:nestId/trace — the per-nest steward slice of the activity
  // trace: same shape/pagination/filters as GET /admin/trace, but ALWAYS
  // pinned to this nest server-side (a ?nest= query param can't widen it).
  // Authorized for the nest owner / admin collaborators via the same
  // canManageStewards rule the grants + steward-roster routes use (it folds
  // the license admin and super_admins in, and open mode is always allowed).
  // Registered before the sub-routers below so it matches first under the
  // LinearRouter. The nest access middleware above already 404s callers with
  // no access at all; this check downgrades read/write collaborators to 403.
  nestsApp.get("/:nestId/trace", async (c) => {
    const nestId = c.req.param("nestId")!;
    if (!(await canManageStewards(nestId, c.get("userId")))) {
      return c.json(
        {
          error:
            "Only the nest owner, a nest admin, or the server admin can view this nest's activity.",
        },
        403,
      );
    }
    const limitRaw = Number(c.req.query("limit"));
    const offsetRaw = Number(c.req.query("offset"));
    const limit = Number.isFinite(limitRaw) ? limitRaw : 25;
    const offset = Number.isFinite(offsetRaw) ? offsetRaw : 0;
    const { events, total } = await listTraceEvents({
      limit,
      offset,
      kind: c.req.query("kind") as any,
      nestId, // pinned — the caller cannot query outside their nest
      user: c.req.query("user") || undefined,
    });
    return c.json({ count: events.length, total, limit, offset, events });
  });

  // GET /nests/:nestId/activity-log?node=<id> | ?folder=<path> — the admin
  // activity log for one document, one folder, or (neither) the whole nest:
  // who changed, reviewed, commented on, deleted, read, retrieved or exported
  // it (CU-wdqcq03aw2). ?agent=<name> narrows it to one agent ("what did
  // agent X read"); read rows carry the version served. Same guard as /trace above — owner, nest admin, or
  // server admin; everyone else 403. Registered before the sub-routers so it
  // matches first under the LinearRouter.
  nestsApp.get("/:nestId/activity-log", async (c) => {
    const nestId = c.req.param("nestId")!;
    if (!(await canManageStewards(nestId, c.get("userId")))) {
      return c.json(
        { error: "Only the nest owner, a nest admin, or the server admin can view activity." },
        403,
      );
    }
    const node = c.req.query("node");
    const folder = c.req.query("folder");
    if (node && folder !== undefined) {
      throw new ValidationError("Pass node or folder, not both.");
    }
    const scope = node
      ? { nodeId: assertSafeNodeId(node) }
      : folder !== undefined
        ? { folder: normalizeFolder(folder) }
        : {};
    if (scope.folder !== undefined) {
      if (scope.folder === "") delete (scope as { folder?: string }).folder; // the nest root
      else for (const seg of scope.folder.split("/")) {
        if (!seg || seg === "." || seg === "..") throw new ValidationError("invalid folder");
      }
    }
    const typesRaw = c.req.query("type");
    const types = typesRaw
      ? typesRaw.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;
    if (types?.some((t) => !(ACTIVITY_TYPES as readonly string[]).includes(t))) {
      throw new ValidationError(`type must be one of: ${ACTIVITY_TYPES.join(", ")}`);
    }
    await flushAccessLog();
    const page = await getScopedActivity({
      nestId,
      scope,
      types: types as ActivityType[] | undefined,
      actor: c.req.query("actor") || undefined,
      agent: (() => {
        const a = c.req.query("agent")?.trim();
        if (a && a.length > 200) throw new ValidationError("agent must be at most 200 characters");
        return a || undefined;
      })(),
      limit: Number(c.req.query("limit") ?? 50),
      offset: Number(c.req.query("offset") ?? 0),
    });
    return c.json(page);
  });

  // Nest list/CRUD
  nestsApp.route("/", nestRoutes);

  // Nest-scoped sub-routes
  // Governance nest-level routes (stewards, review-queue)
  nestsApp.route("/:nestId", accessRequestRoutes);
  nestsApp.route("/:nestId", governanceRoutes);
  // Node-level sub-routers all share the /:nestId/nodes base and rely on a
  // greedy /:nodeId{.+} param (node ids are multi-segment paths). Under the
  // LinearRouter (see createApp) the FIRST registered match wins, so mount
  // order = specificity order, longest/most-specific first:
  //   1. annotationRoutes  — /:nodeId/annotations/:threadId/comments, /hosted.
  //      Must precede governanceNodeRoutes: its greedy POST /:nodeId/comments
  //      would otherwise swallow the annotation reply URL (…/annotations/:id/
  //      comments), capturing "…/annotations/:id" as the node id.
  //   2. governanceNodeRoutes — /:nodeId/{approve,reject,submit-review,comments,…}
  //   3. nodeRoutes — CRUD incl. the bare /:nodeId{.+} catch-all, mounted last
  //      so it only matches when no suffix route did.
  //   0. pdfNodeRoutes — POST /pdf (upload) and GET /:nodeId/pdf (the binary).
  //      First, because the /pdf suffix must beat every greedy catch-all; the
  //      GET falls through (next()) when the id is not a pdf node, so a
  //      document whose own id ends in /pdf still reads.
  nestsApp.route("/:nestId/nodes", pdfNodeRoutes);
  nestsApp.route("/:nestId/nodes", annotationRoutes);
  nestsApp.route("/:nestId/nodes", governanceNodeRoutes);
  nestsApp.route("/:nestId/nodes", nodeRoutes);
  // Push Confirmation Gate — MUST precede queryRoutes so this /publish (the
  // gated one) wins under the LinearRouter (first registered match wins).
  // Also owns /pending-pushes* and /push-allowlist.
  nestsApp.route("/:nestId", pushRoutes);
  nestsApp.route("/:nestId", queryRoutes);
  // Hootie chat — read-tier like /context (it IS /context plus a model call).
  nestsApp.route("/:nestId", hootieRoutes);
  nestsApp.route("/:nestId", sharingRoutes);
  nestsApp.route("/:nestId", headlessRoutes);
  nestsApp.route("/:nestId", brandingRoutes);
  nestsApp.route("/:nestId/grants", grantRoutes);
  // "publications" (not "/publish") — POST /:nestId/publish is already taken by
  // the nest-snapshot endpoint in query-routes. These manage per-document
  // public links; the public render surface is the top-level /p route above.
  nestsApp.route("/:nestId/publications", publishRoutes);
  nestsApp.route("/:nestId/teams", nestTeamRoutes);
  nestsApp.route("/:nestId/boards", boardRoutes);
  nestsApp.route("/:nestId/fields", fieldRoutes);
  nestsApp.route("/:nestId/pins", pinRoutes);
  nestsApp.route("/:nestId/edge-types", edgeTypeRoutes);
  nestsApp.route("/:nestId/edges", edgeRoutes);
  nestsApp.route("/:nestId/run", runTriggerRoutes);
  nestsApp.route("/:nestId/runs", runListRoutes);
  nestsApp.route("/:nestId/schedules", scheduleRoutes);
  nestsApp.route("/:nestId/metacognition", metacognitionRoutes);
  nestsApp.route("/:nestId/env", envRoutes);
  nestsApp.route("/:nestId/connectors", connectorRoutes);
  nestsApp.route("/:nestId/hooks", hookNestRoutes);
  nestsApp.route("/:nestId/definitions", definitionRoutes);
  nestsApp.route("/:nestId/structure", structureRoutes);
  nestsApp.route("/:nestId/assets", assetRoutes);
  nestsApp.route("/:nestId/systems", nestSystemRoutes);
  nestsApp.route("/:nestId/mcp", mcpRoutes);

  app.route("/nests", nestsApp);

  // /.well-known/* — discovery namespace, never an SPA route. Must 404 ahead
  // of the catch-all below: OAuth/OIDC discovery clients JSON.parse the body
  // unconditionally, so answering with the index.html shell crashes them with
  // `Unexpected token '<', "<!DOCTYPE "...` instead of falling back cleanly.
  // This server authenticates with Bearer cnst_ keys, not OAuth — no metadata
  // to serve, so 404 is the correct answer.
  // OAuth discovery, served ONLY when the MCP authorization server is turned
  // on. Registered ahead of the blanket 404 below so that with the flag off
  // this whole surface is indistinguishable from before.
  //
  // PUBLIC_BASE_URL is required rather than guessed: `resource` has to equal
  // the URL the user typed into their client, and a value derived from the
  // request Host is both spoofable and wrong behind a proxy. 503 (not 404)
  // because the feature is configured-but-unusable, which is an operator
  // problem worth surfacing, not a missing endpoint.
  app.get("/.well-known/oauth-protected-resource/mcp", (c) => {
    if (!config.MCP_OAUTH_ENABLED) return c.json({ error: "Not found" }, 404);
    if (!config.PUBLIC_BASE_URL)
      return c.json(
        { error: "PUBLIC_BASE_URL must be set to serve OAuth metadata" },
        503,
      );
    return c.json(protectedResourceMetadata(config.PUBLIC_BASE_URL));
  });
  app.get("/.well-known/oauth-authorization-server", (c) => {
    if (!config.MCP_OAUTH_ENABLED) return c.json({ error: "Not found" }, 404);
    if (!config.PUBLIC_BASE_URL)
      return c.json(
        { error: "PUBLIC_BASE_URL must be set to serve OAuth metadata" },
        503,
      );
    return c.json(authorizationServerMetadata(config.PUBLIC_BASE_URL));
  });

  app.route("/oauth", oauthRoutes);

  app.all("/.well-known/*", (c) => c.json({ error: "Not found" }, 404));

  // ─── Dashboard UI (static files served from the bundled dist/web3 dir) ──
  // Hashed asset files are content-addressed — safe to cache forever.
  app.use(
    "/assets/*",
    serveStatic({
      root: UI_DIR_REL,
      onFound: (_p, c) =>
        c.header("Cache-Control", "public, max-age=31536000, immutable"),
    }),
  );
  // index.html is NOT hashed and points at the current bundle — it must never
  // be cached, or a browser keeps loading a stale bundle after every deploy
  // (the workflow-plane UI "not showing up" bug). Always revalidate.
  //
  // The shell is served ONLY to browser document navigations. Anything else
  // reaching here is a miss, not an SPA route: a mistyped API path, a discovery
  // fetch, curl, or an /assets/* file that serveStatic above couldn't find and
  // passed through. Those callers parse what they get, so a 200 HTML page turns
  // a plain 404 into a confusing failure elsewhere (JSON.parse on "<!DOCTYPE",
  // or a <script> tag executing the shell). Give them JSON 404 instead.
  // (isDocumentNavigation, serveIndexShell defined above, shared with the
  // /teams guard.)
  app.get(
    "*",
    async (c, next) => {
      if (isDocumentNavigation(c)) return next();
      return c.json({ error: "Not found" }, 404);
    },
    serveIndexShell,
  );

  // Non-GET requests that matched no route (POST to a mistyped endpoint, the
  // OAuth /register probe) skip the catch-all above and land on Hono's default
  // 404, which is plain text. Same reasoning — answer in JSON.
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  // Error handler — translate common low-level errors into messages
  // the UI can show as-is so users don't see "Internal server error"
  // for predictable failure modes (constraint violations, missing rows,
  // disk/path errors). Anything truly unexpected still falls through
  // to the 500.
  app.onError(async (err, c) => {
    // Vault write-lock timeout: retryable, so it carries Retry-After — the
    // one AppError with a header. Raw engine errors are converted here too,
    // for any route that throws them without passing through toSafeError.
    if (isVaultLockTimeout(err) || err instanceof VaultBusyError) {
      const busy = err instanceof VaultBusyError ? err : new VaultBusyError();
      return c.json({ error: busy.message }, 503, {
        "Retry-After": String(busy.retryAfterSeconds),
      });
    }
    if (err instanceof PlanLimitError) {
      // Only a server admin can change the plan; everyone else is told who to ask.
      const userId = (c as any).get?.("userId") as string | undefined;
      const forAdmin = !!userId && (await isServerAdminUserId(userId).catch(() => false));
      return c.json(
        { error: planLimitMessage(err.limit, err.max, forAdmin), code: "plan_limit", limit: err.limit, max: err.max },
        402,
      );
    }
    if (err instanceof AppError) {
      return c.json({ error: err.message }, err.statusCode as any);
    }

    const e = err as { code?: string; message?: string };
    const code = e.code;
    const msg = e.message || "";

    // The engine refusing a write it judges invalid — a structure rule the
    // document breaks, a reserved path — is the caller's to fix: a 400 with
    // the engine's message (it names the rule), never an opaque 500.
    if (code === "VALIDATION_FAILED" && err instanceof ContextNestError) {
      return c.json({ error: forPeople(msg) }, 400);
    }

    // SQLite constraint errors — surface a clear conflict instead of 500.
    if (code === "SQLITE_CONSTRAINT_UNIQUE") {
      let friendly =
        "That conflicts with existing data. Please change a value and try again.";
      if (msg.includes("node_versions")) {
        friendly =
          "A version record for this node already exists. The document may have been recreated with the same name — pick a different title or remove the old node first.";
      } else if (msg.includes("review_requests")) {
        friendly = "A review request for this node already exists.";
      } else if (msg.includes("nests")) {
        friendly = "A nest with that name already exists.";
      } else if (msg.includes("users")) {
        friendly = "An account with that email already exists.";
      } else if (msg.includes("stewards")) {
        friendly = "That steward is already assigned with the same scope.";
      }
      return c.json({ error: friendly }, 409);
    }
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
      return c.json(
        {
          error:
            "Required related record is missing. Ensure the parent resource still exists.",
        },
        409,
      );
    }
    if (code === "SQLITE_CONSTRAINT_CHECK") {
      return c.json(
        {
          error:
            "Provided value isn't allowed for one of the fields. Double-check your input.",
        },
        400,
      );
    }
    if (code === "SQLITE_CONSTRAINT_NOTNULL") {
      return c.json(
        { error: "A required field is missing. Please fill it in and retry." },
        400,
      );
    }

    // Node filesystem errors when reading/writing nest folders.
    if (code === "ENOENT") {
      return c.json(
        { error: "The requested file or folder doesn't exist." },
        404,
      );
    }
    if (code === "EACCES" || code === "EPERM") {
      return c.json(
        { error: "Server doesn't have permission to access that file." },
        500,
      );
    }
    if (code === "ENOSPC") {
      return c.json(
        { error: "Out of disk space on the server. Free up space and retry." },
        507,
      );
    }

    // JSON / body parse failures — Hono surfaces SyntaxError.
    if (err instanceof SyntaxError && msg.toLowerCase().includes("json")) {
      return c.json({ error: "Request body isn't valid JSON." }, 400);
    }

    console.error("Unhandled error:", err);
    return c.json(
      {
        error:
          "Something went wrong on the server. Try again — if it keeps failing, check the server log.",
      },
      500,
    );
  });

  return app;
}
