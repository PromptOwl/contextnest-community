/**
 * Public docs site settings API (CU-wdqcq05jhm) — mounted under /nests/:nestId,
 * gated at the nest "admin" tier in app.ts (owner, nest admin, server admin),
 * the same tier as visibility / reader-mode / branding.
 *
 *   GET    /site                    → settings, domain + DNS records, site URL, pages
 *   PATCH  /site { domain?, settings? }
 *   POST   /site/verify-domain      → check the TXT record, mark the domain live
 *   POST   /site/verify-public-url  → check the TXT record for public_url's host
 *   PUT    /site/pages { node_id, path | null } → a page's custom URL
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { ValidationError } from "../shared/errors.js";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import {
  domainForNest,
  getSiteRow,
  setCustomPath,
  sitePaths,
  updateSite,
  verificationRecord,
  verifyDomain,
  verifyPublicUrl,
  verifiedPublicUrl,
  type SiteRow,
} from "./settings.js";
import { siteForNest } from "./build.js";

export const siteSettingsRoutes = new Hono<AuthEnv>();

async function describe(nestId: string, row: SiteRow, reqUrl: string) {
  const nest = (await getDb().get("SELECT visibility, reader_mode FROM nests WHERE id = ?", [nestId])) as
    | { visibility: string; reader_mode: number }
    | undefined;
  const live = nest?.visibility === "public" && nest.reader_mode === 1;
  const site = live ? await siteForNest(nestId, requestBaseUrl(reqUrl)) : null;
  const custom = new Map((await sitePaths(nestId)).filter((p) => p.kind === "custom").map((p) => [p.nodeId, p.path]));
  return {
    live,
    // Why the site is off, in words the settings panel can show as-is.
    reason: live ? null : "The site is published when the nest is public and Reader Mode is on.",
    url: site ? `${site.site.base}/` : null,
    domain: row.domain,
    domain_verified: !!row.domainVerifiedAt,
    domain_verified_at: row.domainVerifiedAt,
    serving_domain: domainForNest(nestId, row),
    dns: row.domain
      ? {
          txt: verificationRecord(row),
          // Where the domain must point. Set by the operator (SITE_DNS_TARGET);
          // without it the panel tells the owner to ask their admin.
          cname: config.SITE_DNS_TARGET || null,
        }
      : null,
    // public_url is used (and /d/<key> 301s to it) only once its host is proven.
    public_url_verified: !!verifiedPublicUrl(nestId, row),
    public_url_dns: row.settings.public_url
      ? {
          name: `_contextnest.${new URL(row.settings.public_url).hostname}`,
          value: `contextnest-site=${row.domainToken}`,
        }
      : null,
    settings: row.settings,
    pages: site
      ? site.site.pages.map((p) => ({ node_id: p.nodeId, title: p.title, path: p.path, custom: custom.has(p.nodeId) }))
      : [],
  };
}

siteSettingsRoutes.get("/site", async (c) => {
  const nestId = c.req.param("nestId")!;
  return c.json(await describe(nestId, await getSiteRow(nestId), c.req.url));
});

siteSettingsRoutes.patch("/site", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<{ domain?: unknown; settings?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (body.domain !== undefined && body.domain !== null && typeof body.domain !== "string") {
    throw new ValidationError("domain must be a string or null");
  }
  if (body.domain === undefined && body.settings === undefined) throw new ValidationError("provide domain and/or settings");
  const row = await updateSite(nestId, { domain: body.domain as string | null | undefined, settings: body.settings });
  return c.json(await describe(nestId, row, c.req.url));
});

siteSettingsRoutes.post("/site/verify-domain", async (c) => {
  const nestId = c.req.param("nestId")!;
  const row = await verifyDomain(nestId);
  return c.json(await describe(nestId, row, c.req.url));
});

siteSettingsRoutes.post("/site/verify-public-url", async (c) => {
  const nestId = c.req.param("nestId")!;
  const row = await verifyPublicUrl(nestId);
  return c.json(await describe(nestId, row, c.req.url));
});

siteSettingsRoutes.put("/site/pages", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<{ node_id?: unknown; path?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  if (typeof body.node_id !== "string" || !body.node_id) throw new ValidationError("node_id is required");
  if (body.path !== null && typeof body.path !== "string") throw new ValidationError("path must be a string or null");
  await setCustomPath(nestId, body.node_id, body.path as string | null);
  return c.json(await describe(nestId, await getSiteRow(nestId), c.req.url));
});
