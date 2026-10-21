/**
 * Public docs site — HTTP surface (CU-wdqcq05jhm). No auth: everything here is
 * the approved content of nests their owners made public with Reader Mode on.
 *
 *   /d/<key>/                 home        /d/<key>/<path>        a page
 *   /d/<key>/<path>.md        Markdown twin (also: Accept: text/markdown)
 *   /d/<key>/tags/<tag>       topic hub   /d/<key>/glossary       glossary
 *   /d/<key>/sitemap.xml  robots.txt  llms.txt  llms-full.txt  <indexnow-key>.txt
 *   /robots.txt, /sitemap.xml        server level (sitemap index of every site)
 *   /site-domain-check?domain=        200 only for verified docs domains (TLS `ask`)
 *
 * A verified custom domain (or DOCS_SITES) gets the same site at its root, and
 * the /d/<key> copy 301s there so search engines see one URL per page. So does
 * a site whose owner set a public URL behind their own reverse proxy — except
 * for requests that arrive through that proxy. Anonymous visitors to the
 * app's own URLs for a site nest (/nest/<id>, /?nest=<id>&doc=) are 301'd to
 * the page, which is how links already out there keep their value; signed-in
 * users, and `?app=1`, still get the app.
 *
 * Redirects that depend on state an owner can change (reader mode, the domain)
 * are 301s with a bounded Cache-Control, so a browser that cached one recovers
 * when the owner changes their mind instead of being stuck forever.
 */
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { config } from "../config.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { getSessionIdFromRequest, resolveSession } from "../auth/sessions.js";
import { findSiteNest, getSite, placements, siteNests, TYPES, type SiteNest, type SiteView } from "./build.js";
import { AI_SEARCH_AGENTS, AI_TRAINING_AGENTS, cspFor, renderServerRobots, renderSitemapIndex } from "./render.js";
import { nestIdForDomain } from "./settings.js";

const NOT_FOUND = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not found</title></head><body><main><h1>Not found</h1></main></body></html>`;

const CACHE = "public, max-age=300, stale-while-revalidate=86400";

function wantsMarkdown(c: Context): boolean {
  const accept = c.req.header("Accept") || "";
  return /text\/markdown/.test(accept) && !/text\/html/.test(accept);
}

/** decodeURIComponent that answers null for malformed input instead of throwing. */
function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A 301 the browser may cache only for `maxAge` seconds. */
function movedTo(c: Context, location: string, maxAge: number, vary?: string) {
  const headers: Record<string, string> = { Location: location, "Cache-Control": `public, max-age=${maxAge}` };
  if (vary) headers.Vary = vary;
  return c.body(null, 301, headers);
}

function serverOrigin(c: Context): string {
  return requestBaseUrl(c.req.url);
}

function notFound(c: Context) {
  return c.body(NOT_FOUND, 404, { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" });
}

/** Serve one file of a built site, honouring If-None-Match / If-Modified-Since. */
function serveFile(c: Context, built: SiteView, rest: string) {
  const { site } = built;
  const prefix = site.prefix;
  let path = rest.replace(/^\/+/, "");
  // One URL per page: no trailing slash (except the home page, which is "/").
  if (path.endsWith("/")) return movedTo(c, `${prefix}/${path.replace(/\/+$/, "")}`, 86400);
  if (path === "index.html") return movedTo(c, `${prefix}/`, 86400);
  if (path.endsWith(".html")) return movedTo(c, `${prefix}/${path.slice(0, -5)}`, 86400);
  const lower = path.toLowerCase();
  if (lower !== path && built.has(lower)) return movedTo(c, `${prefix}/${lower}`, 86400);
  if (wantsMarkdown(c) && built.has(`${path || "index"}.md`)) path = `${path || "index"}.md`;

  const file = path === "404" || path === "410" ? undefined : built.file(path);
  if (!file) {
    const key = lower.replace(/\.md$/, "");
    const to = site.redirects.get(key);
    if (to) return movedTo(c, lower.endsWith(".md") && to.startsWith("/") ? `${to}.md` : to, 86400);
    const gone = site.gone.has(key);
    const page = built.file(gone ? "410" : "404")!;
    return c.body(page.body, gone ? 410 : 404, {
      "Content-Type": page.type,
      "Cache-Control": "public, max-age=60",
      "Content-Security-Policy": cspFor(page.body),
      "X-Robots-Tag": "noindex",
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": file.type,
    "Cache-Control": CACHE,
    ETag: file.etag,
    Vary: "Accept",
    "X-Content-Type-Options": "nosniff",
  };
  if (file.lastModified) headers["Last-Modified"] = file.lastModified;
  if (file.type === TYPES.html) {
    headers["Content-Security-Policy"] = cspFor(file.body);
    headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
    const links = [`<${prefix}/llms.txt>; rel="describedby"; type="text/plain"`];
    if (site.byPath.has(path)) links.unshift(`<${prefix}/${path || "index"}.md>; rel="alternate"; type="text/markdown"`);
    headers.Link = links.join(", ");
    if (site.settings.noindex) headers["X-Robots-Tag"] = "noindex";
  } else if (file.type === TYPES.md) {
    // The Markdown twin is for agents; the HTML page is the one to rank.
    const pagePath = path === "index.md" ? "" : path.slice(0, -3);
    headers["X-Robots-Tag"] = "noindex";
    headers.Link = `<${site.base}/${pagePath}>; rel="canonical"`;
  }
  const inm = c.req.header("If-None-Match");
  if (inm && inm.split(",").map((s) => s.trim()).includes(file.etag)) return c.body(null, 304, headers);
  const ims = c.req.header("If-Modified-Since");
  if (!inm && ims && file.lastModified && Date.parse(ims) >= Date.parse(file.lastModified)) {
    return c.body(null, 304, headers);
  }
  if (c.req.method === "HEAD") return c.body(null, 200, headers);
  return c.body(file.body, 200, headers);
}

export const siteRoutes = new Hono();

// One catch-all, parsed by hand: the app's LinearRouter can't mix a :param
// with a trailing * in one pattern. Mounted at "/d", that "*" also matches
// "/dashboard", "/docs"…: anything that isn't /d/<key> goes on to the app.
siteRoutes.get("*", async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  const m = /^\/d\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m) return next();
  const key = decode(m[1]);
  const rest = m[2] === undefined ? "" : decode(m[2].slice(1));
  if (key === null || rest === null) return notFound(c);
  if (m[2] === undefined) return movedTo(c, `/d/${m[1]}/`, 86400);
  const found = await findSiteNest(key);
  if (!found) return notFound(c);
  const built = await getSite(found.nest, serverOrigin(c));
  const { site } = built;
  if (!site.prefix.startsWith("/d/")) {
    // The site lives on a domain or behind the owner's proxy. A request that
    // came through that proxy is served; anything else moves to the real URL.
    // The header picks 200 or 301 here (never the body's URLs, which always
    // name the public URL), so a shared cache must key on it.
    const fwd = (c.req.header("X-Forwarded-Host") || "").toLowerCase();
    const realHost = new URL(site.base).host.toLowerCase();
    const res =
      fwd !== realHost
        ? movedTo(c, `${site.base}/${rest}${new URL(c.req.url).search}`, 3600)
        : serveFile(c, built, rest);
    res.headers.append("Vary", "X-Forwarded-Host");
    return res;
  }
  // A key that is not the canonical one (the id when the slug works) → canonical.
  if (key !== found.key) return movedTo(c, `${site.prefix}/${rest}`, 86400);
  return serveFile(c, built, rest);
});

/**
 * Requests to a docs domain — a verified custom domain or a DOCS_SITES entry.
 * Mounted ahead of every other route (auth included): on that host the whole
 * URL space is the docs site, read-only. OPTIONS gets an empty 204 (no CORS
 * grant), and every other method a 405.
 */
export async function docsDomainMiddleware(c: Context, next: () => Promise<void>) {
  const host = c.req.header("Host") ?? new URL(c.req.url).host;
  const nestId = await nestIdForDomain(host);
  if (!nestId) return next();
  if (c.req.method === "OPTIONS") return c.body(null, 204, { Allow: "GET, HEAD, OPTIONS" });
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return c.body("Method not allowed", 405, { Allow: "GET, HEAD, OPTIONS" });
  }
  // The host → nest map is cached for 30s, but whether that nest still has a
  // site is not: siteNests() drops a nest the moment it goes private or Reader
  // Mode goes off on this instance (and within its 5s TTL on the others).
  const nest = (await siteNests()).find((n) => n.id === nestId);
  if (!nest) return notFound(c);
  const built = await getSite(nest, serverOrigin(c));
  // Serve only while this domain IS the site's home.
  if (built.site.prefix !== "" || new URL(built.site.base).host.toLowerCase() !== host.toLowerCase().replace(/:\d+$/, "")) {
    return notFound(c);
  }
  const rest = decode(new URL(c.req.url).pathname.slice(1));
  if (rest === null) return notFound(c);
  return serveFile(c, built, rest);
}

/** Server-level robots.txt: crawl the public surfaces, not the API. */
export async function robotsTxt(c: Context) {
  const base = serverOrigin(c);
  const body = renderServerRobots(`${base}/sitemap.xml`, ["/nests/", "/auth/", "/admin/", "/mcp", "/oauth/", "/me/", "/index"]);
  return c.body(body, 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": CACHE });
}

/** Server-level sitemap index: one sitemap per docs site hosted under /d/. */
export async function sitemapIndex(c: Context) {
  const base = serverOrigin(c);
  const maps = (await placements(base)).filter((p) => !p.place.canonicalElsewhere).map((p) => `${p.place.base}/sitemap.xml`);
  return c.body(renderSitemapIndex(maps), 200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": CACHE });
}

/**
 * For an edge proxy issuing TLS certificates on demand (Caddy `on_demand_tls
 * ask`, and the like): 200 only for a domain verified for a live docs site.
 */
export async function siteDomainCheck(c: Context) {
  // Optional shared secret, so only the edge can ask which domains are served.
  const token = config.SITE_DOMAIN_CHECK_TOKEN;
  if (token && !sameSecret(c.req.query("token") ?? "", token)) return c.text("forbidden", 403);
  const domain = (c.req.query("domain") || "").toLowerCase();
  const nestId = domain ? await nestIdForDomain(domain) : null;
  if (!nestId || !(await siteNests()).some((n) => n.id === nestId)) return c.text("unknown", 404);
  return c.text("ok", 200);
}

// Search and AI crawlers, by User-Agent: the agents robots.txt names, plus the
// common "bot" / "crawler" / "spider" words other indexers use.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CRAWLER_UA = new RegExp(
  [...[...AI_SEARCH_AGENTS, ...AI_TRAINING_AGENTS].map(escapeRe), "bot\\b", "crawler", "spider", "slurp", "facebookexternalhit"].join("|"),
  "i",
);

export function isCrawler(c: Context): boolean {
  return CRAWLER_UA.test(c.req.header("User-Agent") || "");
}

/**
 * 301 an anonymous browser from the app's URL for a site nest to the page.
 * Returns null when the request should go on to the app as before. A `doc`
 * that is not on the site (a draft, a typo) lands on the site's home page.
 */
export async function legacySiteRedirect(c: Context): Promise<Response | null> {
  if (config.AUTH_MODE !== "key") return null; // open mode: every visitor is the operator
  const url = new URL(c.req.url);
  if (url.searchParams.get("app") === "1") return null;
  // An Authorization header means an API client, not a crawler.
  if (c.req.header("Authorization")) return null;
  const nestId = /^\/nest\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? (url.pathname === "/" ? url.searchParams.get("nest") : null);
  if (!nestId) return null;
  const nest: SiteNest | undefined = (await siteNests()).find((n) => n.id === nestId);
  if (!nest) return null;
  // Signed-in browsers keep the app. A stale session cookie doesn't count:
  // that visitor is anonymous now and gets the page like a crawler does.
  const sessionId = getSessionIdFromRequest(c);
  if (sessionId && (await resolveSession(sessionId))) return null;
  const built = await getSite(nest, serverOrigin(c));
  const doc = url.searchParams.get("doc");
  const path = doc ? (built.site.pages.find((p) => p.nodeId === doc)?.path ?? "") : "";
  // Varies on the session: a signed-in visitor of the same URL gets the app.
  return movedTo(c, `${built.site.base}/${path}`, 3600, "Cookie, Authorization");
}
