/**
 * Public docs site — the static-site build (CU-wdqcq05jhm).
 *
 * A nest that is PUBLIC with Reader Mode on gets a docs site: every APPROVED
 * document pre-rendered to complete HTML at a clean path, plus a sitemap,
 * robots.txt, llms.txt and a Markdown twin per page. The build is a pure
 * function of the nest's approved content, so it is done once per content
 * version and served from memory — and the same output can be written to a
 * folder for any static host (`buildSiteFiles`, scripts/site-export.ts).
 *
 * Content rule: the same one as the public reader (filterAccessible /
 * resolveReadableBody) — only nodes with an approved version, at that
 * version. A draft, or an unapproved edit to an approved page, never renders.
 */
import { createHash } from "node:crypto";
import { parseDocument } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { engineCache } from "../nodes/engine.js";
import { reconstructApproved } from "../governance/approved-body.js";
import { describe, renderMarkdown, type Heading } from "./markdown.js";
import {
  renderLlmsTxt,
  renderNotFound,
  renderPage,
  renderRobots,
  renderSitemap,
} from "./render.js";

export interface SiteNest {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  home: string | null;
}

export interface SitePage {
  nodeId: string;
  /** "" for the home page, otherwise "guides/setup". */
  path: string;
  title: string;
  description: string;
  markdown: string;
  html: string;
  headings: Heading[];
  updated: string | null;
  tags: string[];
  crumbs: Array<{ title: string; path: string | null }>;
  prev: SitePage | null;
  next: SitePage | null;
}

export interface NavFolder {
  name: string;
  path: string;
  pages: SitePage[];
  folders: NavFolder[];
}

export interface Site {
  nest: SiteNest;
  /** Absolute origin + prefix every URL hangs off, no trailing slash. */
  base: string;
  /** Path prefix for in-site links: "/d/<key>" on the server host, "" on a docs domain. */
  prefix: string;
  pages: SitePage[];
  byPath: Map<string, SitePage>;
  nav: NavFolder;
  homeSynthesized: boolean;
}

// ─── Which nests have a site, and where it lives ────────────────────────────

/** Every nest that is public with Reader Mode on, oldest first. */
export async function siteNests(): Promise<SiteNest[]> {
  const rows = (await getDb().all(
    `SELECT id, name, slug, description, reader_home_node FROM nests
      WHERE visibility = 'public' AND reader_mode = 1
      ORDER BY created_at, id`,
    [],
  )) as Array<{ id: string; name: string; slug: string; description: string | null; reader_home_node: string | null }>;
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, description: r.description, home: r.reader_home_node }));
}

/**
 * The URL key for a nest: its slug, unless an older site already owns that
 * slug (slugs are unique per owner, not per server) — then its id. Stable:
 * enabling a newer nest never moves an existing site.
 */
export function siteKey(nest: SiteNest, all: SiteNest[]): string {
  const first = all.find((n) => n.slug === nest.slug);
  return first && first.id !== nest.id ? nest.id : nest.slug;
}

export async function findSiteNest(key: string): Promise<{ nest: SiteNest; key: string } | null> {
  const all = await siteNests();
  const nest = all.find((n) => siteKey(n, all) === key) ?? all.find((n) => n.id === key);
  return nest ? { nest, key: siteKey(nest, all) } : null;
}

export function hostForNest(nestId: string): string | null {
  for (const [host, id] of config.DOCS_SITES) if (id === nestId) return host;
  return null;
}

export function nestIdForHost(host: string | undefined): string | null {
  if (!host) return null;
  return config.DOCS_SITES.get(host.toLowerCase().replace(/:\d+$/, "")) ?? null;
}

// ─── Building ────────────────────────────────────────────────────────────────

const LEAD = /^(overview|index|readme|welcome|home)$/i;
const leafOf = (p: string) => p.split("/").pop() ?? p;

function isLead(path: string, title: string): boolean {
  const parts = path.split("/");
  const l = parts[parts.length - 1].toLowerCase();
  const folder = (parts[parts.length - 2] ?? "").toLowerCase();
  return LEAD.test(l) || LEAD.test(title) || (!!folder && l === folder);
}

function humanize(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Generic lead titles ("Overview") read as the body's own H1 when there is one. */
function displayTitle(title: string, body: string): string {
  if (!LEAD.test(title)) return title;
  const m = body.match(/^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/);
  return m ? m[1].replace(/[*_`]/g, "").trim() : title;
}

/** The body opens with `# Title` by convention; the page template sets the H1. */
function stripLeadingTitle(body: string, title: string): string {
  const m = body.match(/^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/);
  if (!m) return body;
  const norm = (s: string) => s.replace(/[*_`]/g, "").trim().toLowerCase();
  return norm(m[1]) === norm(title) ? body.slice(m[0].length) : body;
}

interface Source {
  nodeId: string;
  rel: string;
  title: string;
  body: string;
  description: string | null;
  tags: string[];
  updated: string | null;
}

interface ApprovedRow {
  node_id: string;
  approved_version: number;
  approved_at: string;
}

/**
 * What the site is built from, and a key that changes whenever it does: the
 * approved versions plus the live document set. One indexed query and the
 * engine's cached listing — cheap enough to run on every request, so a cache
 * hit never reconstructs a single document.
 */
async function contentState(nestId: string): Promise<{ rows: ApprovedRow[]; live: Set<string>; key: string }> {
  const rows = (await getDb().all(
    "SELECT node_id, approved_version, approved_at FROM approved_versions WHERE nest_id = ? ORDER BY node_id",
    [nestId],
  )) as ApprovedRow[];
  const { storage } = await engineCache.get(nestId);
  // A deleted document can keep its approved_versions row; the live listing
  // is what says it still exists.
  const live = new Set((await storage.discoverDocuments()).map((d: { id: string }) => d.id));
  const key = createHash("sha256")
    .update(JSON.stringify([rows, [...live].sort()]))
    .digest("hex")
    .slice(0, 16);
  return { rows, live, key };
}

async function approvedSources(nestId: string, rows: ApprovedRow[], live: Set<string>): Promise<Source[]> {
  const { versions } = await engineCache.get(nestId);
  const sources: Source[] = [];
  for (const row of rows) {
    if (!live.has(row.node_id) || row.node_id.endsWith("--annotations")) continue;
    let raw: string;
    try {
      raw = (await reconstructApproved(versions, nestId, row.node_id, row.approved_version)).raw;
    } catch {
      continue;
    }
    let fm: Record<string, any>;
    let body: string;
    try {
      const doc = parseDocument(`${row.node_id}.md`, raw, row.node_id);
      fm = (doc.frontmatter ?? {}) as Record<string, any>;
      body = doc.body ?? "";
    } catch {
      continue;
    }
    // HTML artifacts render under the artifact sandbox (/p), not as a docs page.
    if (fm.type === "artifact" || /^\s*<(?:!doctype|html)\b/i.test(body)) continue;
    const rel = row.node_id.replace(/^nodes\//, "");
    sources.push({
      nodeId: row.node_id,
      rel,
      title: String(fm.title || humanize(leafOf(rel))),
      body,
      description: typeof fm.description === "string" && fm.description.trim() ? fm.description.trim() : null,
      tags: Array.isArray(fm.tags) ? fm.tags.map((t: unknown) => String(t).replace(/^#/, "")) : [],
      updated: String(fm.updated_at || row.approved_at || "") || null,
    });
  }
  return sources;
}

/** Resolve `[[target]]` against the site: path first, then title, then a unique slug. */
function resolveTarget(target: string, sources: Source[]): Source | null {
  const raw = target.trim().replace(/^\/+/, "").replace(/\.md$/i, "");
  if (!raw) return null;
  const norm = (s: string) => s.replace(/^nodes\//, "").toLowerCase();
  if (raw.includes("/")) {
    const want = norm(raw);
    const byPath = sources.find((s) => norm(s.nodeId) === want);
    if (byPath) return byPath;
    const slug = leafOf(want);
    const bySlug = sources.filter((s) => norm(s.nodeId).endsWith(`/${slug}`) || norm(s.nodeId) === slug);
    return bySlug.length === 1 ? bySlug[0] : null;
  }
  const want = raw.toLowerCase();
  return (
    sources.find((s) => s.title.toLowerCase() === want) ??
    sources.find((s) => leafOf(s.rel).toLowerCase() === want) ??
    null
  );
}

function buildSite(nest: SiteNest, sources: Source[], base: string, prefix: string): Site {
  // When every page lives under one top folder ("docs/…"), URLs start inside it.
  const tops = new Set(sources.map((s) => (s.rel.includes("/") ? s.rel.split("/")[0] : "")));
  const strip = tops.size === 1 && !tops.has("") ? `${[...tops][0]}/` : "";
  const pathOf = new Map(sources.map((s) => [s.nodeId, s.rel.startsWith(strip) ? s.rel.slice(strip.length) : s.rel]));

  const home =
    sources.find((s) => s.nodeId === nest.home) ??
    sources.find((s) => !pathOf.get(s.nodeId)!.includes("/") && LEAD.test(leafOf(pathOf.get(s.nodeId)!)));
  if (home) pathOf.set(home.nodeId, "");

  const href = (path: string) => `${prefix}/${path}`;
  const pages: SitePage[] = sources.map((s) => {
    const path = pathOf.get(s.nodeId)!;
    const title = displayTitle(s.title, s.body);
    const markdown = s.body;
    const { html, headings } = renderMarkdown(stripLeadingTitle(markdown, title), (target) => {
      const hit = resolveTarget(target, sources);
      return hit ? href(pathOf.get(hit.nodeId)!) : null;
    });
    const segs = path ? path.split("/").slice(0, -1) : [];
    const crumbs = segs.map((seg, i) => ({ title: humanize(seg), path: null as string | null, folder: segs.slice(0, i + 1).join("/") }));
    return {
      nodeId: s.nodeId,
      path,
      title,
      description: s.description ?? (describe(stripLeadingTitle(markdown, title)) || `${title} — ${nest.name}`),
      markdown,
      html,
      headings,
      updated: s.updated,
      tags: s.tags,
      crumbs: crumbs.map(({ title, folder }) => ({ title, path: folder })),
      prev: null,
      next: null,
    };
  });

  // Nav tree: lead page first in each folder, then pages by title, then subfolders.
  const root: NavFolder = { name: nest.name, path: "", pages: [], folders: [] };
  const folderAt = (path: string): NavFolder => {
    let node = root;
    if (!path) return node;
    let acc = "";
    for (const seg of path.split("/")) {
      acc = acc ? `${acc}/${seg}` : seg;
      let next = node.folders.find((f) => f.path === acc);
      if (!next) {
        next = { name: humanize(seg), path: acc, pages: [], folders: [] };
        node.folders.push(next);
      }
      node = next;
    }
    return node;
  };
  for (const p of pages) {
    if (p.path === "") continue;
    folderAt(p.path.split("/").slice(0, -1).join("/")).pages.push(p);
  }
  const order: SitePage[] = [];
  const homePage = pages.find((p) => p.path === "");
  if (homePage) order.push(homePage);
  const sortFolder = (f: NavFolder) => {
    f.pages.sort((a, b) => {
      const la = isLead(a.path, a.title) ? 0 : 1;
      const lb = isLead(b.path, b.title) ? 0 : 1;
      return la - lb || a.title.localeCompare(b.title);
    });
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    order.push(...f.pages);
    f.folders.forEach(sortFolder);
  };
  sortFolder(root);
  order.forEach((p, i) => {
    p.prev = order[i - 1] ?? null;
    p.next = order[i + 1] ?? null;
  });
  // A crumb links to its folder's lead page when it has one.
  const leadOf = new Map<string, string>();
  const collectLeads = (f: NavFolder) => {
    const lead = f.pages.find((p) => isLead(p.path, p.title));
    if (lead) leadOf.set(f.path, lead.path);
    f.folders.forEach(collectLeads);
  };
  collectLeads(root);
  for (const p of pages) p.crumbs = p.crumbs.map((c) => ({ title: c.title, path: leadOf.get(c.path!) ?? null }));

  return {
    nest,
    base,
    prefix,
    pages: order,
    byPath: new Map(order.map((p) => [p.path, p])),
    nav: root,
    homeSynthesized: !homePage,
  };
}

// ─── Cache ───────────────────────────────────────────────────────────────────

interface Built {
  key: string;
  site: Site;
  files: Map<string, { body: string; type: string; etag: string }>;
}
const cache = new Map<string, Built>();
const MAX_CACHED_SITES = 32;

const TYPES = {
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

function etagOf(body: string): string {
  return `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`;
}

/**
 * The rendered site for a nest at a given base, rebuilt only when its
 * approved content (or the live document set) changes. Keys in `files` are
 * site-relative: "" (home), "guides/setup", "guides/setup.md", "sitemap.xml",
 * "robots.txt", "llms.txt", "llms-full.txt", "404".
 */
export async function getSite(nest: SiteNest, base: string, prefix: string): Promise<Built> {
  const state = await contentState(nest.id);
  const key = `${state.key}|${JSON.stringify(nest)}`;
  const cacheKey = `${nest.id}|${base}|${prefix}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.key === key) return hit;

  const sources = await approvedSources(nest.id, state.rows, state.live);
  const site = buildSite(nest, sources, base, prefix);
  const files = new Map<string, { body: string; type: string; etag: string }>();
  const put = (path: string, body: string, type: string) => files.set(path, { body, type, etag: etagOf(body) });
  if (site.homeSynthesized) put("", renderPage(site, null), TYPES.html);
  for (const page of site.pages) {
    put(page.path, renderPage(site, page), TYPES.html);
    put(`${page.path || "index"}.md`, page.markdown, TYPES.md);
  }
  put("sitemap.xml", renderSitemap(site), TYPES.xml);
  put("robots.txt", renderRobots(`${base}/sitemap.xml`), TYPES.txt);
  const llms = renderLlmsTxt(site);
  put("llms.txt", llms.index, TYPES.txt);
  put("llms-full.txt", llms.full, TYPES.txt);
  put("404", renderNotFound(site), TYPES.html);

  const built = { key, site, files };
  // Bounded: without PUBLIC_BASE_URL the base comes from the request's Host,
  // so a client cycling Host values must not grow this without limit.
  cache.delete(cacheKey);
  cache.set(cacheKey, built);
  while (cache.size > MAX_CACHED_SITES) cache.delete(cache.keys().next().value!);
  return built;
}

/**
 * The whole site as static files, for any static host — `index.html` per
 * page directory, the Markdown twins, sitemap, robots, llms.txt and 404.html.
 * Links are root-relative, so `base` should be the domain it will live on.
 */
export async function buildSiteFiles(nestId: string, base: string): Promise<Record<string, string>> {
  const all = await siteNests();
  const nest = all.find((n) => n.id === nestId);
  if (!nest) throw new Error(`Nest ${nestId} is not a public Reader Mode nest`);
  const origin = base.replace(/\/$/, "");
  const prefix = new URL(origin).pathname.replace(/\/$/, "");
  const { files } = await getSite(nest, origin, prefix);
  const out: Record<string, string> = {};
  for (const [path, file] of files) {
    if (path === "404") out["404.html"] = file.body;
    else if (file.type === TYPES.html) out[path ? `${path}/index.html` : "index.html"] = file.body;
    else out[path] = file.body;
  }
  return out;
}
