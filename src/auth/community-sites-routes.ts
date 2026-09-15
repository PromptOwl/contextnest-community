/**
 * /admin/community-sites — manage official community site connections
 * (CU-wdqcq0247t). Each row is a site trusted for one-click SSO auto-login
 * (GET /auth/sso): a name, a url (the ticket's expected `aud`), a shared
 * secret, and an active flag. Extends the single OFFICIAL_COMMUNITY_SSO_
 * SECRET/PUBLIC_BASE_URL env-var pair — see community-sites.ts for how the
 * handshake now tries every active site's secret. `secret` is WRITE-ONLY:
 * GET/POST/PATCH responses only report `secret_set`, mirroring the
 * mcp_signing_secret/oidc_client_secret discipline in /admin/settings.
 *
 * Auth is the shared flexAuthMiddleware (open or key mode), applied at
 * registration in app.ts — same convention as teamRoutes/nestRoutes.
 */
import { Hono } from "hono";
import type { AuthEnv } from "./middleware.js";
import { config } from "../config.js";
import { isServerAdminUserId } from "../shared/access.js";
import {
  listCommunitySites,
  createCommunitySite,
  updateCommunitySite,
  deleteCommunitySite,
  loadActiveCommunitySites,
  type CommunitySite,
} from "./community-sites.js";

// Same server-admin guard as the other /admin/* operator surfaces (open
// mode, the license admin, or a superadmin via access.yaml ∪ DB grants).
const serverAdminAllowed = async (c: any) =>
  config.AUTH_MODE === "open" || (await isServerAdminUserId(c.get("userId")));

const isHttpUrl = (v: string) => /^https?:\/\/\S+$/i.test(v);

const serializeSite = (site: CommunitySite) => ({
  id: site.id,
  name: site.name,
  url: site.url,
  secret_set: !!site.secret,
  is_active: site.is_active,
  created_at: site.created_at,
  updated_at: site.updated_at,
});

export const communitySiteRoutes = new Hono<AuthEnv>();

communitySiteRoutes.get("/", async (c) => {
  if (!(await serverAdminAllowed(c)))
    return c.json({ error: "Only the server admin can view this." }, 403);
  const sites = await listCommunitySites();
  return c.json({ community_sites: sites.map(serializeSite) });
});

communitySiteRoutes.post("/", async (c) => {
  if (!(await serverAdminAllowed(c)))
    return c.json({ error: "Only the server admin can add a community site." }, 403);

  let body: { name?: unknown; url?: unknown; secret?: unknown; is_active?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const url =
    typeof body.url === "string" ? body.url.trim().replace(/\/$/, "") : "";
  const secret = typeof body.secret === "string" ? body.secret.trim() : "";
  const is_active = body.is_active === undefined ? true : !!body.is_active;

  if (!name) return c.json({ error: "A name is required." }, 400);
  if (!url || !isHttpUrl(url))
    return c.json({ error: "A valid http(s) site URL is required." }, 400);
  if (!secret || secret.length < 16)
    return c.json({ error: "A secret of at least 16 characters is required." }, 400);

  try {
    const site = await createCommunitySite({ name, url, secret, is_active });
    await loadActiveCommunitySites();
    return c.json(serializeSite(site), 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique|duplicate/i.test(msg))
      return c.json({ error: "A community site with this URL already exists." }, 409);
    throw err;
  }
});

communitySiteRoutes.patch("/:id", async (c) => {
  if (!(await serverAdminAllowed(c)))
    return c.json({ error: "Only the server admin can edit a community site." }, 403);

  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const patch: Partial<{
    name: string;
    url: string;
    secret: string;
    is_active: boolean;
  }> = {};
  if ("name" in body) {
    const v = typeof body.name === "string" ? body.name.trim() : "";
    if (!v) return c.json({ error: "A name is required." }, 400);
    patch.name = v;
  }
  if ("url" in body) {
    const v =
      typeof body.url === "string" ? body.url.trim().replace(/\/$/, "") : "";
    if (!v || !isHttpUrl(v))
      return c.json({ error: "A valid http(s) site URL is required." }, 400);
    patch.url = v;
  }
  if ("secret" in body) {
    const v = typeof body.secret === "string" ? body.secret.trim() : "";
    if (!v || v.length < 16)
      return c.json({ error: "A secret of at least 16 characters is required." }, 400);
    patch.secret = v;
  }
  if ("is_active" in body) patch.is_active = !!body.is_active;

  try {
    const site = await updateCommunitySite(id, patch);
    if (!site) return c.json({ error: "Community site not found." }, 404);
    await loadActiveCommunitySites();
    return c.json(serializeSite(site));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique|duplicate/i.test(msg))
      return c.json({ error: "A community site with this URL already exists." }, 409);
    throw err;
  }
});

communitySiteRoutes.delete("/:id", async (c) => {
  if (!(await serverAdminAllowed(c)))
    return c.json({ error: "Only the server admin can remove a community site." }, 403);

  const id = c.req.param("id");
  const removed = await deleteCommunitySite(id);
  if (!removed) return c.json({ error: "Community site not found." }, 404);
  await loadActiveCommunitySites();
  return c.json({ ok: true, id });
});
