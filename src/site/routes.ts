/**
 * Public docs site — HTTP surface (CU-wdqcq05jhm). No auth: everything here is
 * the approved content of nests their owners made public with Reader Mode on.
 *
 *   /d/<key>/                 home        /d/<key>/<path>        a page
 *   /d/<key>/<path>.md        Markdown twin (also: Accept: text/markdown)
 *   /d/<key>/sitemap.xml      /d/<key>/llms.txt      /d/<key>/llms-full.txt
 *   /robots.txt, /sitemap.xml server-level (sitemap index of every site)
 *
 * A docs domain from DOCS_SITES gets the same site at its root, and the
 * /d/<key> copy 301s there so search engines see one URL per page. Anonymous
 * visitors to the app's own URLs for a site nest (/nest/<id>, /?nest=<id>&doc=)
 * are 301'd to the page, which is how the links already out there keep their
 * value. Signed-in users, and `?app=1`, still get the app.
 */
import { Hono, type Context } from "hono";
import { config } from "../config.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { getSessionIdFromRequest } from "../auth/sessions.js";
import {
  findSiteNest,
  getSite,
  hostForNest,
  nestIdForHost,
  siteKey,
  siteNests,
  type SiteNest,
} from "./build.js";
import { renderRobots, renderSitemapIndex } from "./render.js";

const NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not found</title></head><body><main><h1>Not found</h1></main></body></html>`;

const CACHE = "public, max-age=300, stale-while-revalidate=86400";

function wantsMarkdown(c: Context): boolean {
  const accept = c.req.header("Accept") || "";
  return /text\/markdown/.test(accept) && !/text\/html/.test(accept);
}

/** Serve one file of a built site, honouring If-None-Match. */
async function serveSite(c: Context, nest: SiteNest, base: string, prefix: string, rest: string) {
  const built = await getSite(nest, base, prefix);
  let path = rest.replace(/^\/+/, "");
  // One URL per page: no trailing slash (except the home page, which is "/").
  if (path.endsWith("/")) return c.redirect(`${prefix}/${path.replace(/\/+$/, "")}`, 301);
  if (path === "index.html") return c.redirect(`${prefix}/`, 301);
  if (path.endsWith("/index.html")) return c.redirect(`${prefix}/${path.slice(0, -"/index.html".length)}`, 301);
  if (wantsMarkdown(c) && built.files.has(`${path || "index"}.md`)) path = `${path || "index"}.md`;

  const file = built.files.get(path);
  if (!file || path === "404") {
    const nf = built.files.get("404")!;
    return c.body(nf.body, 404, { "Content-Type": nf.type, "Cache-Control": "public, max-age=60" });
  }
  const headers: Record<string, string> = {
    "Content-Type": file.type,
    "Cache-Control": CACHE,
    ETag: file.etag,
    Vary: "Accept",
    "X-Content-Type-Options": "nosniff",
  };
  if (file.type.startsWith("text/html")) {
    // Static pages: our one inline style + inline filter script, nothing else.
    headers["Content-Security-Policy"] =
      "default-src 'none'; img-src * data:; media-src *; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
    headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
  }
  const inm = c.req.header("If-None-Match");
  if (inm && inm.split(",").map((s) => s.trim()).includes(file.etag)) {
    return c.body(null, 304, headers);
  }
  return c.body(file.body, 200, headers);
}

/** The site's absolute base and in-site link prefix for this nest. */
async function placement(c: Context, nest: SiteNest): Promise<{ base: string; prefix: string; host: string | null }> {
  const host = hostForNest(nest.id);
  if (host) return { base: `https://${host}`, prefix: "", host };
  const all = await siteNests();
  const prefix = `/d/${encodeURIComponent(siteKey(nest, all))}`;
  return { base: `${requestBaseUrl(c.req.url)}${prefix}`, prefix, host: null };
}

export const siteRoutes = new Hono();

// One catch-all, parsed by hand: the app's LinearRouter can't mix a :param
// with a trailing * in one pattern.
siteRoutes.get("*", async (c) => {
  const pathname = new URL(c.req.url).pathname;
  const m = /^\/d\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return c.html(NOT_FOUND, 404);
  const key = decodeURIComponent(m[1]);
  if (m[2] === undefined) return c.redirect(`/d/${m[1]}/`, 301);
  const rest = decodeURIComponent(m[2].slice(1));
  const found = await findSiteNest(key);
  if (!found) return c.html(NOT_FOUND, 404);
  const { base, prefix, host } = await placement(c, found.nest);
  if (host) return c.redirect(`${base}/${rest}${new URL(c.req.url).search}`, 301);
  // A key that is not the canonical one (the id when the slug works) → canonical.
  if (key !== found.key) return c.redirect(`${prefix}/${rest}`, 301);
  return serveSite(c, found.nest, base, prefix, rest);
});

/**
 * Requests to a docs domain from DOCS_SITES. Mounted ahead of every other
 * route: on that host, the whole URL space is the docs site.
 */
export async function docsDomainMiddleware(c: Context, next: () => Promise<void>) {
  const nestId = nestIdForHost(c.req.header("Host") ?? new URL(c.req.url).host);
  if (!nestId) return next();
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.text("Method not allowed", 405);
  const nest = (await siteNests()).find((n) => n.id === nestId);
  if (!nest) return c.html(NOT_FOUND, 404);
  const host = hostForNest(nest.id)!;
  return serveSite(c, nest, `https://${host}`, "", c.req.path);
}

/** Server-level robots.txt: crawl the public surfaces, not the API. */
export async function robotsTxt(c: Context) {
  const base = requestBaseUrl(c.req.url);
  const body = renderRobots(`${base}/sitemap.xml`, ["/nests/", "/auth/", "/admin/", "/mcp", "/oauth/", "/me/"]);
  return c.body(body, 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": CACHE });
}

/** Server-level sitemap index: one sitemap per docs site hosted under /d/. */
export async function sitemapIndex(c: Context) {
  const base = requestBaseUrl(c.req.url);
  const all = await siteNests();
  const maps = all
    .filter((n) => !hostForNest(n.id))
    .map((n) => `${base}/d/${encodeURIComponent(siteKey(n, all))}/sitemap.xml`);
  return c.body(renderSitemapIndex(maps), 200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": CACHE });
}

/**
 * 301 an anonymous browser from the app's URL for a site nest to the page.
 * Returns null when the request should go on to the app as before.
 */
export async function legacySiteRedirect(c: Context): Promise<Response | null> {
  if (config.AUTH_MODE !== "key") return null; // open mode: every visitor is the operator
  const url = new URL(c.req.url);
  if (url.searchParams.get("app") === "1") return null;
  if (c.req.header("Authorization") || getSessionIdFromRequest(c)) return null;
  const nestId = /^\/nest\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? (url.pathname === "/" ? url.searchParams.get("nest") : null);
  if (!nestId) return null;
  const nest = (await siteNests()).find((n) => n.id === nestId);
  if (!nest) return null;
  const { base, prefix } = await placement(c, nest);
  const doc = url.searchParams.get("doc");
  let path = "";
  if (doc) {
    const built = await getSite(nest, base, prefix);
    path = built.site.pages.find((p) => p.nodeId === doc)?.path ?? "";
  }
  return c.redirect(`${base}/${path}`, 301);
}
