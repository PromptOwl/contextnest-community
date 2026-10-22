/**
 * Public docs site — the static-site build (CU-wdqcq05jhm).
 *
 * A nest that is PUBLIC with Reader Mode on gets a docs site: every APPROVED
 * document pre-rendered to complete HTML at a clean path, plus a sitemap,
 * robots.txt, llms.txt, a Markdown twin per page, tag hub pages and a
 * glossary. The build is a pure function of the nest's approved content and
 * its site settings, so it runs once per version of those and is served from
 * memory — and the same output can be written to a folder for any static host
 * (`buildSiteFiles`, scripts/site-export.ts).
 *
 * Content rule: the same one as the public reader (filterAccessible /
 * resolveReadableBody) — only nodes with an approved version, at that
 * version. A draft, or an unapproved edit to an approved page, never renders.
 *
 * Semantic links: every page knows what it links to (wikilinks,
 * contextnest:// links, document links), what links to it, what it was
 * derived from, the tags it shares with other pages and the glossary terms it
 * mentions. The page shows backlinks and ranked related pages, and the
 * structured data names the same relationships.
 */
import { buildWikiTitleIndex, parseDocument, resolveWikiTarget } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { engineCache } from "../nodes/engine.js";
import { hashContent } from "../governance/version-service.js";
import { reconstructApproved } from "../governance/approved-body.js";
import { parseStoredBranding, type NestBranding } from "../shared/branding.js";
import { describe, renderMarkdown, rewriteDocumentLinks, slugifyHeading, type Heading } from "./markdown.js";
import {
  renderGlossary,
  renderGone,
  renderLlmsTxt,
  renderNotFound,
  renderPage,
  renderRedirectsFile,
  renderRobots,
  renderSitemap,
  renderTagPage,
} from "./render.js";
import {
  domainForNest,
  ensureSiteKey,
  getSiteRow,
  isSitePath,
  nestIdForSiteKey,
  recordPaths,
  redirectKey,
  redirectLoops,
  sitePaths,
  siteRowsFor,
  trustedHosts,
  verifiedPublicUrl,
  type SiteRow,
  type SiteSettings,
} from "./settings.js";
import { pingIndexNow } from "./indexnow.js";
import { siteNestsGeneration } from "./invalidate.js";
import { config } from "../config.js";

export interface SiteNest {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  home: string | null;
  branding: NestBranding | null;
}

export interface PageRef {
  title: string;
  path: string;
  description: string;
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
  linksTo: PageRef[];
  linkedFrom: PageRef[];
  basedOn: PageRef[];
  related: PageRef[];
  /** Tags with their own hub page. */
  tagPages: Array<{ tag: string; path: string }>;
  terms: Array<{ term: string; href: string }>;
}

export interface NavFolder {
  name: string;
  path: string;
  pages: SitePage[];
  folders: NavFolder[];
}

export interface TagHub {
  tag: string;
  path: string;
  definition: string | null;
  pages: SitePage[];
}

export interface GlossaryEntry {
  term: string;
  id: string;
  definition: string;
  tagPath: string | null;
}

export interface Site {
  nest: SiteNest;
  settings: SiteSettings;
  /** Site name as shown everywhere. */
  name: string;
  /** Absolute origin + prefix every URL hangs off, no trailing slash. */
  base: string;
  /** Path prefix for in-site links: "/d/<key>" on the server host, "" on a docs domain. */
  prefix: string;
  /** This server's own origin — media and the MCP endpoint live here. */
  serverOrigin: string;
  pages: SitePage[];
  byPath: Map<string, SitePage>;
  nav: NavFolder;
  tags: TagHub[];
  glossary: GlossaryEntry[];
  homeSynthesized: boolean;
  /** Old paths → where they went now (history + manual redirects). */
  redirects: Map<string, string>;
  /** Paths of pages that are gone for good (410). */
  gone: Set<string>;
  indexnowKey: string;
}

// ─── Which nests have a site, and where it lives ────────────────────────────

/** Every nest that is public with Reader Mode on, oldest first. */
// Read on every public request, so cached briefly. Changes on this instance
// (visibility, reader mode, name, branding, deletion) bump the generation and
// take effect at once; other instances catch up within the TTL.
const SITE_NESTS_TTL_MS = 5_000;
let siteNestsCache: { at: number; generation: number; nests: Promise<SiteNest[]> } | null = null;

export function siteNests(): Promise<SiteNest[]> {
  const gen = siteNestsGeneration();
  if (siteNestsCache && siteNestsCache.generation === gen && Date.now() - siteNestsCache.at < SITE_NESTS_TTL_MS) {
    return siteNestsCache.nests;
  }
  const nests = loadSiteNests();
  siteNestsCache = { at: Date.now(), generation: gen, nests };
  nests.catch(() => {
    if (siteNestsCache?.nests === nests) siteNestsCache = null;
  });
  return nests;
}

async function loadSiteNests(): Promise<SiteNest[]> {
  const rows = (await getDb().all(
    `SELECT id, name, slug, description, reader_home_node, branding_json FROM nests
      WHERE visibility = 'public' AND reader_mode = 1
      ORDER BY created_at, id`,
    [],
  )) as Array<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    reader_home_node: string | null;
    branding_json: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    home: r.reader_home_node,
    branding: parseStoredBranding(r.branding_json, r.id),
  }));
}

/**
 * Find a live site by its /d/<key>. The key belongs to one nest for good
 * (ensureSiteKey); a nest id always works too and 301s to the key.
 */
export async function findSiteNest(key: string): Promise<{ nest: SiteNest; key: string } | null> {
  const nestId = await nestIdForSiteKey(key);
  const all = await siteNests();
  let nest = nestId ? all.find((n) => n.id === nestId) : undefined;
  // A site never built yet has no key row: match its slug or id directly.
  if (!nest && !nestId) nest = all.find((n) => n.id === key || n.slug === key);
  if (!nest) return null;
  return { nest, key: await ensureSiteKey(nest.id, nest.slug) };
}

export interface SiteOptions {
  /**
   * Use public_url even before its host is verified. Only for a static export:
   * its files are hosted wherever the operator puts them, and nothing this
   * server serves redirects there.
   */
  unverifiedPublicUrl?: boolean;
}

export interface Placement {
  base: string;
  prefix: string;
  /** Set when the site's real home is elsewhere (a domain or public_url). */
  canonicalElsewhere: boolean;
  domain: string | null;
  /**
   * The base is a host this server can vouch for: a verified domain or
   * public_url, DOCS_SITES, or PUBLIC_BASE_URL. Only such a site pings IndexNow.
   */
  verified: boolean;
}

/**
 * Where a nest's site lives: its verified domain, else the public URL the
 * owner set for a reverse-proxied path (once its host is verified — /d/<key>
 * 301s there, so an unproven one would make this server an open redirect),
 * else /d/<key> on this server.
 */
export async function placementFor(
  nest: SiteNest,
  row: SiteRow,
  serverOrigin: string,
  opts: SiteOptions = {},
): Promise<Placement> {
  const domain = domainForNest(nest.id, row);
  if (domain) return { base: `https://${domain}`, prefix: "", canonicalElsewhere: true, domain, verified: true };
  const publicUrl = opts.unverifiedPublicUrl ? (row.settings.public_url ?? null) : verifiedPublicUrl(nest.id, row);
  if (publicUrl) {
    const u = new URL(publicUrl);
    const prefix = u.pathname.replace(/\/+$/, "");
    return { base: `${u.origin}${prefix}`, prefix, canonicalElsewhere: true, domain: null, verified: !opts.unverifiedPublicUrl };
  }
  const prefix = `/d/${encodeURIComponent(await ensureSiteKey(nest.id, nest.slug))}`;
  return { base: `${serverOrigin}${prefix}`, prefix, canonicalElsewhere: false, domain: null, verified: !!config.PUBLIC_BASE_URL };
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

export function tagSlug(tag: string): string {
  return tag
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  derivedFrom: string[];
  updated: string | null;
}

interface ApprovedRow {
  node_id: string;
  approved_version: number;
  approved_at: string;
}

interface Inputs {
  rows: ApprovedRow[];
  live: Set<string>;
  row: SiteRow;
  paths: Array<{ path: string; nodeId: string; kind: "custom" | "history" }>;
  definitions: Array<{ term: string; definition: string; linked_tag: string | null }>;
  key: string;
}

/**
 * Everything the site is built from, and a key that changes whenever any of
 * it does. A handful of indexed queries and the engine's cached listing —
 * cheap enough to run on every request, so a cache hit never reconstructs a
 * single document.
 */
async function inputsFor(nest: SiteNest): Promise<Inputs> {
  const db = getDb();
  const rows = (await db.all(
    "SELECT node_id, approved_version, approved_at FROM approved_versions WHERE nest_id = ? ORDER BY node_id",
    [nest.id],
  )) as ApprovedRow[];
  const { storage } = await engineCache.get(nest.id);
  // A deleted document can keep its approved_versions row; the live listing
  // is what says it still exists.
  const live = new Set((await storage.discoverDocuments()).map((d: { id: string }) => d.id));
  const row = await getSiteRow(nest.id);
  const paths = await sitePaths(nest.id);
  const definitions = (await db.all(
    "SELECT term, definition, linked_tag FROM definitions WHERE nest_id = ? ORDER BY LOWER(term)",
    [nest.id],
  )) as Inputs["definitions"];
  const key = hashContent(
    JSON.stringify([rows, [...live].sort(), nest, row, paths.filter((p) => p.kind === "custom"), definitions]),
  ).slice(0, 16);
  return { rows, live, row, paths, definitions, key };
}

async function approvedSources(nestId: string, rows: ApprovedRow[], live: Set<string>): Promise<Source[]> {
  const { versions } = await engineCache.get(nestId);
  const sources: Source[] = [];
  for (const row of rows) {
    if (!live.has(row.node_id) || row.node_id.endsWith("--annotations")) continue;
    let raw: string;
    try {
      raw = (await reconstructApproved(versions, nestId, row.node_id, row.approved_version)).raw;
    } catch (err) {
      console.warn(`[site] nest ${nestId}: skipped ${row.node_id} v${row.approved_version}, its approved version can't be rebuilt`, err);
      continue;
    }
    let fm: Record<string, any>;
    let body: string;
    try {
      const doc = parseDocument(`${row.node_id}.md`, raw, row.node_id);
      fm = (doc.frontmatter ?? {}) as Record<string, any>;
      body = doc.body ?? "";
    } catch (err) {
      console.warn(`[site] nest ${nestId}: skipped ${row.node_id}, its approved version doesn't parse`, err);
      continue;
    }
    // HTML artifacts render under the artifact sandbox (/p), not as a docs page.
    if (fm.type === "artifact" || /^\s*<(?:!doctype|html)\b/i.test(body)) continue;
    // A §1.12 view is intro-only on the open web, as on /p: its blocks resolve
    // other nodes and feed data to frames, which only a nest member may see.
    // The `view:` frontmatter is never emitted; a note stands in for the blocks.
    if (fm.type === "view") body = viewIntroForSite(body);
    const rel = row.node_id.replace(/^nodes\//, "");
    sources.push({
      nodeId: row.node_id,
      rel,
      title: String(fm.title || humanize(leafOf(rel))),
      body,
      description: typeof fm.description === "string" && fm.description.trim() ? fm.description.trim() : null,
      tags: Array.isArray(fm.tags) ? [...new Set(fm.tags.map((t: unknown) => String(t).replace(/^#/, "")))] as string[] : [],
      derivedFrom: Array.isArray(fm.derived_from) ? fm.derived_from.map(String) : [],
      updated: String(fm.updated_at || row.approved_at || "") || null,
    });
  }
  return sources;
}

/** Notice that stands in for a view's blocks on the public docs site. */
export const SITE_VIEW_NOTICE = "This page is a live view. Its data is available to nest members.";

function viewIntroForSite(intro: string): string {
  const text = intro.trim();
  return `${text ? `${text}\n\n` : ""}> ${SITE_VIEW_NOTICE}\n`;
}

/**
 * A resolver for document references on the site. The engine's wiki grammar
 * (id or title, `#anchor`, `[[ ]]`) comes first, so a link resolves here as it
 * does everywhere else; then the forms only a docs page uses: a path without
 * `nodes/`, an `x.md` link, and a leaf name that matches one page.
 */
function targetResolver(sources: Source[]): (target: string) => Source | null {
  const index = buildWikiTitleIndex(sources.map((s) => ({ id: s.nodeId, frontmatter: { title: s.title }, body: "" })));
  const byId = new Map(sources.map((s) => [s.nodeId, s]));
  return (target) => {
    const id = resolveWikiTarget(target.trim(), index);
    return (id && byId.get(id)) || resolveSitePath(target, sources);
  };
}

function resolveSitePath(target: string, sources: Source[]): Source | null {
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

function absolutize(url: string | null | undefined, serverOrigin: string): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return url.startsWith("/") ? `${serverOrigin}${url}` : null;
}

function buildSite(nest: SiteNest, sources: Source[], inputs: Inputs, place: Placement, serverOrigin: string): Site {
  const { row, paths, definitions } = inputs;
  const settings = row.settings;
  const name = settings.title || nest.branding?.site_title || nest.name;

  // ── Paths: auto from the folder tree, overridden by custom URLs. ──
  // When every page lives under one top folder ("docs/…"), URLs start inside it.
  const tops = new Set(sources.map((s) => (s.rel.includes("/") ? s.rel.split("/")[0] : "")));
  const strip = tops.size === 1 && !tops.has("") ? `${[...tops][0]}/` : "";
  const pathOf = new Map(
    sources.map((s) => [s.nodeId, (s.rel.startsWith(strip) ? s.rel.slice(strip.length) : s.rel).toLowerCase()]),
  );
  const home =
    sources.find((s) => s.nodeId === nest.home) ??
    sources.find((s) => !pathOf.get(s.nodeId)!.includes("/") && LEAD.test(leafOf(pathOf.get(s.nodeId)!)));
  const custom = new Map(paths.filter((p) => p.kind === "custom").map((p) => [p.nodeId, p.path]));
  for (const s of sources) {
    const c = custom.get(s.nodeId);
    if (c && s !== home) pathOf.set(s.nodeId, c);
  }
  if (home) pathOf.set(home.nodeId, "");
  // A custom URL that lands on another page's automatic path wins; that page
  // steps aside to a suffixed path.
  const taken = new Map<string, string>();
  for (const s of [...sources].sort((a, b) => Number(custom.has(b.nodeId)) - Number(custom.has(a.nodeId)))) {
    let p = pathOf.get(s.nodeId)!;
    if (taken.has(p) && p !== "") {
      let n = 2;
      while (taken.has(`${p}-${n}`)) n++;
      p = `${p}-${n}`;
      pathOf.set(s.nodeId, p);
    }
    taken.set(p, s.nodeId);
  }

  const href = (path: string) => `${place.prefix}/${path}`;
  const byNode = new Map(sources.map((s) => [s.nodeId, s]));

  // ── Tags and glossary. ──
  const tagCount = new Map<string, number>();
  for (const s of sources) for (const t of s.tags) tagCount.set(t.toLowerCase(), (tagCount.get(t.toLowerCase()) ?? 0) + 1);
  // A tag gets a hub page once two pages share it — a one-page hub is thin content.
  const hubTags = new Set([...tagCount].filter(([, n]) => n >= 2).map(([t]) => t));
  // Definitions have no review step: any editor's definition is public at once,
  // as it already is in the public reader. Accepted and documented in API.md.
  const glossary: GlossaryEntry[] = [];
  const termIds = new Set<string>();
  for (const d of definitions) {
    let id = slugifyHeading(d.term);
    while (termIds.has(id)) id = `${id}-x`;
    termIds.add(id);
    const tag = d.linked_tag?.replace(/^#/, "").toLowerCase() ?? null;
    glossary.push({ term: d.term, id, definition: d.definition, tagPath: tag && hubTags.has(tag) ? `tags/${tagSlug(tag)}` : null });
  }
  const termLinks = glossary.map((g) => ({ term: g.term, href: href(`glossary#${g.id}`) }));

  // ── Render bodies, collecting the links between pages. ──
  const linksOut = new Map<string, Set<string>>();
  const rendered = new Map<string, { html: string; headings: Heading[]; title: string; description: string }>();
  const resolveTarget = targetResolver(sources);
  for (const s of sources) {
    const title = displayTitle(s.title, s.body);
    const body = stripLeadingTitle(s.body, title);
    const { html, headings, linked } = renderMarkdown(body, {
      resolve: (target) => {
        const hit = resolveTarget(target);
        return hit ? { href: href(pathOf.get(hit.nodeId)!), nodeId: hit.nodeId } : null;
      },
      terms: termLinks,
    });
    linked.delete(s.nodeId);
    linksOut.set(s.nodeId, linked);
    rendered.set(s.nodeId, {
      html,
      headings,
      title,
      description: s.description ?? (describe(body) || `${title} — ${name}`),
    });
  }
  const linksIn = new Map<string, Set<string>>();
  for (const [from, tos] of linksOut) for (const to of tos) {
    if (!linksIn.has(to)) linksIn.set(to, new Set());
    linksIn.get(to)!.add(from);
  }
  const ref = (nodeId: string): PageRef => ({
    title: rendered.get(nodeId)!.title,
    path: pathOf.get(nodeId)!,
    description: rendered.get(nodeId)!.description,
  });

  // ── Related pages: shared tags weighted by rarity, plus links either way
  //    and pages cited together. Deterministic, explainable, no model needed. ──
  const N = Math.max(sources.length, 2);
  const idf = (t: string) => Math.log(N / (tagCount.get(t.toLowerCase()) ?? N)) + 0.1;
  function relatedFor(s: Source): PageRef[] {
    const scores = new Map<string, number>();
    const add = (id: string, v: number) => id !== s.nodeId && byNode.has(id) && scores.set(id, (scores.get(id) ?? 0) + v);
    const myTags = new Set(s.tags.map((t) => t.toLowerCase()));
    for (const o of sources) for (const t of o.tags) if (myTags.has(t.toLowerCase())) add(o.nodeId, idf(t));
    for (const id of linksOut.get(s.nodeId) ?? []) add(id, 1.5);
    for (const id of linksIn.get(s.nodeId) ?? []) add(id, 1.5);
    for (const citer of linksIn.get(s.nodeId) ?? []) for (const id of linksOut.get(citer) ?? []) add(id, 0.5);
    return [...scores]
      .filter(([, v]) => v >= 0.5)
      .sort((a, b) => b[1] - a[1] || ref(a[0]).title.localeCompare(ref(b[0]).title))
      .slice(0, 5)
      .map(([id]) => ref(id));
  }

  const pages: SitePage[] = sources.map((s) => {
    const path = pathOf.get(s.nodeId)!;
    const r = rendered.get(s.nodeId)!;
    const segs = path ? path.split("/").slice(0, -1) : [];
    return {
      nodeId: s.nodeId,
      path,
      title: r.title,
      description: r.description,
      markdown: rewriteDocumentLinks(s.body, (target) => {
        const hit = resolveTarget(target);
        return hit ? `${place.base}/${pathOf.get(hit.nodeId)}` : null;
      }),
      html: r.html,
      headings: r.headings,
      updated: s.updated,
      tags: s.tags,
      crumbs: segs.map((seg, i) => ({ title: humanize(seg), path: segs.slice(0, i + 1).join("/") })),
      prev: null,
      next: null,
      linksTo: [...(linksOut.get(s.nodeId) ?? [])].map(ref),
      linkedFrom: [...(linksIn.get(s.nodeId) ?? [])].map(ref).sort((a, b) => a.title.localeCompare(b.title)),
      basedOn: s.derivedFrom
        .map((d) => resolveTarget(d))
        .filter((x): x is Source => !!x && x.nodeId !== s.nodeId)
        .map((x) => ref(x.nodeId)),
      related: relatedFor(s),
      tagPages: s.tags.filter((t) => hubTags.has(t.toLowerCase())).map((t) => ({ tag: t, path: `tags/${tagSlug(t)}` })),
      terms: [],
    };
  });

  // ── Nav tree: lead page first in each folder, then pages by title, then subfolders. ──
  const root: NavFolder = { name, path: "", pages: [], folders: [] };
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
  // The nav follows the document tree (not custom URLs), so moving a page's
  // URL never reshuffles the sidebar.
  const treePath = (s: Source) => (s.rel.startsWith(strip) ? s.rel.slice(strip.length) : s.rel).toLowerCase();
  for (const p of pages) {
    if (p.path === "") continue;
    folderAt(treePath(byNode.get(p.nodeId)!).split("/").slice(0, -1).join("/")).pages.push(p);
  }
  const order: SitePage[] = [];
  const homePage = pages.find((p) => p.path === "");
  if (homePage) order.push(homePage);
  const sortFolder = (f: NavFolder) => {
    f.pages.sort((a, b) => {
      const la = isLead(treePath(byNode.get(a.nodeId)!), a.title) ? 0 : 1;
      const lb = isLead(treePath(byNode.get(b.nodeId)!), b.title) ? 0 : 1;
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
    const lead = f.pages.find((p) => isLead(treePath(byNode.get(p.nodeId)!), p.title));
    if (lead) leadOf.set(f.path, lead.path);
    f.folders.forEach(collectLeads);
  };
  collectLeads(root);
  for (const p of pages) {
    const segs = treePath(byNode.get(p.nodeId)!).split("/").slice(0, -1);
    p.crumbs = p.path === "" ? [] : segs.map((seg, i) => ({ title: humanize(seg), path: leadOf.get(segs.slice(0, i + 1).join("/")) ?? null }));
  }

  // ── Tag hubs. ──
  const defByTag = new Map(
    definitions.filter((d) => d.linked_tag).map((d) => [d.linked_tag!.replace(/^#/, "").toLowerCase(), d.definition]),
  );
  const defByTerm = new Map(definitions.map((d) => [d.term.toLowerCase(), d.definition]));
  const tags: TagHub[] = [...hubTags]
    .map((t) => ({
      tag: pages.flatMap((p) => p.tags).find((x) => x.toLowerCase() === t) ?? t,
      path: `tags/${tagSlug(t)}`,
      definition: defByTag.get(t) ?? defByTerm.get(t) ?? null,
      pages: order.filter((p) => p.tags.some((x) => x.toLowerCase() === t)),
    }))
    .sort((a, b) => a.tag.localeCompare(b.tag));

  // ── Redirects: every path a page has had, plus the owner's own list. ──
  const pageByNode = new Map(pages.map((p) => [p.nodeId, p]));
  const current = new Set(pages.map((p) => p.path));
  const redirects = new Map<string, string>();
  const gone = new Set<string>();
  for (const p of paths) {
    if (current.has(p.path)) continue;
    const now = pageByNode.get(p.nodeId);
    if (now) redirects.set(p.path, href(now.path));
    else gone.add(p.path);
  }
  // Validated on save; re-checked here so a stored value can never become an
  // open redirect ("//evil.example" reads as another host, and an absolute URL
  // must be on a host this nest proved, which can lapse) or a 301 loop.
  const hosts = trustedHosts(nest.id, row);
  const loops = redirectLoops(settings.redirects ?? []);
  for (const r of settings.redirects ?? []) {
    if (!isSitePath(r.from)) continue;
    if (!isSitePath(r.to)) {
      if (!/^https:\/\/[^\\\s]+$/.test(r.to)) continue;
      let host: string;
      try {
        host = new URL(r.to).host.toLowerCase();
      } catch {
        continue;
      }
      if (!hosts.has(host)) continue;
    }
    const from = redirectKey(r.from);
    if (current.has(from) || loops.has(from)) continue;
    redirects.set(from, r.to.startsWith("/") ? href(r.to.replace(/^\/+/, "")) : r.to);
    gone.delete(from);
  }

  return {
    nest: {
      ...nest,
      branding: nest.branding && {
        ...nest.branding,
        logo_url: absolutize(nest.branding.logo_url, serverOrigin),
        banner_url: absolutize(nest.branding.banner_url, serverOrigin),
        favicon_url: absolutize(nest.branding.favicon_url, serverOrigin),
      },
    },
    settings,
    name,
    base: place.base,
    prefix: place.prefix,
    serverOrigin,
    pages: order,
    byPath: new Map(order.map((p) => [p.path, p])),
    nav: root,
    tags,
    glossary,
    homeSynthesized: !homePage,
    redirects,
    gone,
    indexnowKey: row.indexnowKey,
  };
}

// ─── Cache ───────────────────────────────────────────────────────────────────

export interface SiteFile {
  body: string;
  type: string;
  etag: string;
  lastModified: string | null;
}

export interface Built {
  key: string;
  origin: string;
  site: Site;
  files: Map<string, SiteFile>;
  bytes: number;
}
// LRU, one entry per nest, capped by count AND by size. Worst case held:
// MAX_CACHE_BYTES, or a single site bigger than that (the one being served
// is never evicted). Size is estimated as UTF-16 length of the bodies.
const cache = new Map<string, Built>();
const MAX_CACHED_SITES = 32;
let maxCacheBytes = 256 * 1024 * 1024;
let cacheBytes = 0;
/** Tests shrink the size cap to exercise eviction. */
export function setCacheBytesForTests(n: number | null): void {
  maxCacheBytes = n ?? 256 * 1024 * 1024;
}

function cachePut(nestId: string, built: Built): void {
  const old = cache.get(nestId);
  if (old) cacheBytes -= old.bytes;
  cache.delete(nestId);
  cache.set(nestId, built);
  cacheBytes += built.bytes;
  while (cache.size > 1 && (cache.size > MAX_CACHED_SITES || cacheBytes > maxCacheBytes)) {
    const [oldest, entry] = cache.entries().next().value!;
    cache.delete(oldest);
    cacheBytes -= entry.bytes;
  }
}

export const TYPES = {
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

function etagOf(body: string): string {
  return `"${hashContent(body).slice(0, 32)}"`;
}

function httpDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.includes("T") || iso.endsWith("Z") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toUTCString();
}

/**
 * Sites are built once per content version against ONE origin — the server's
 * PUBLIC_BASE_URL, or a placeholder when it is unset — and each request gets
 * a view with its own origin swapped in. So a client cycling Host headers
 * costs a string replace, never a rebuild, and can't evict real traffic.
 */
const ORIGIN_PLACEHOLDER = "https://site-origin.invalid";
let warnedNoBaseUrl = false;

function buildOrigin(): string {
  if (config.PUBLIC_BASE_URL) return config.PUBLIC_BASE_URL;
  if (!warnedNoBaseUrl) {
    warnedNoBaseUrl = true;
    console.warn(
      "[site] PUBLIC_BASE_URL is not set: public docs sites under /d/ build their canonical URLs from each request's Host header. Set PUBLIC_BASE_URL in production (or give the site a verified domain).",
    );
  }
  return ORIGIN_PLACEHOLDER;
}

/** A built site seen from one request origin. */
export interface SiteView {
  site: Site;
  has(path: string): boolean;
  file(path: string): SiteFile | undefined;
  paths(): string[];
}

function viewFor(built: Built, origin: string): SiteView {
  const from = built.origin;
  if (from === origin || from !== ORIGIN_PLACEHOLDER) {
    return { site: built.site, has: (p) => built.files.has(p), file: (p) => built.files.get(p), paths: () => [...built.files.keys()] };
  }
  const swap = (v: string) => v.split(from).join(origin);
  const tag = hashContent(origin).slice(0, 8);
  const site: Site = { ...built.site, base: swap(built.site.base), serverOrigin: origin };
  return {
    site,
    has: (p) => built.files.has(p),
    file: (p) => {
      const f = built.files.get(p);
      return f && { ...f, body: swap(f.body), etag: `${f.etag.slice(0, -1)}-${tag}"` };
    },
    paths: () => [...built.files.keys()],
  };
}

/**
 * The rendered site for a nest, seen from `requestOrigin`. Rebuilt only when
 * its approved content, settings, custom URLs or glossary change. Keys in
 * `files` are site-relative: "" (home), "guides/setup", "guides/setup.md",
 * "tags/x", "glossary", "sitemap.xml", "robots.txt", "llms.txt",
 * "llms-full.txt", "<indexnow key>.txt", "404", "410".
 */
export async function getSite(nest: SiteNest, requestOrigin: string, opts: SiteOptions = {}): Promise<SiteView> {
  const origin = buildOrigin();
  const inputs = await inputsFor(nest);
  const place = await placementFor(nest, inputs.row, origin, opts);
  const key = `${inputs.key}|${place.base}`;
  const hit = cache.get(nest.id);
  if (hit && hit.key === key && hit.origin === origin) {
    cache.delete(nest.id);
    cache.set(nest.id, hit);
    return viewFor(hit, requestOrigin);
  }

  // Requests that miss together share one build: a crawler burst after an
  // edit must not start a full rebuild per request.
  const flightKey = `${nest.id}|${key}|${origin}`;
  let flight = inFlight.get(flightKey);
  if (!flight) {
    flight = build(nest, inputs, place, key, origin, hit).finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, flight);
  }
  return viewFor(await flight, requestOrigin);
}

const inFlight = new Map<string, Promise<Built>>();

async function build(
  nest: SiteNest,
  inputs: Inputs,
  place: Placement,
  key: string,
  origin: string,
  hit: Built | undefined,
): Promise<Built> {
  const sources = await approvedSources(nest.id, inputs.rows, inputs.live);
  const site = buildSite(nest, sources, inputs, place, origin);
  const files = new Map<string, SiteFile>();
  const put = (path: string, body: string, type: string, updated: string | null = null) =>
    files.set(path, { body, type, etag: etagOf(body), lastModified: httpDate(updated) });
  if (site.homeSynthesized) put("", renderPage(site, null), TYPES.html);
  for (const page of site.pages) {
    put(page.path, renderPage(site, page), TYPES.html, page.updated);
    put(`${page.path || "index"}.md`, page.markdown, TYPES.md, page.updated);
  }
  for (const hub of site.tags) put(hub.path, renderTagPage(site, hub), TYPES.html);
  if (site.glossary.length) put("glossary", renderGlossary(site), TYPES.html);
  put("sitemap.xml", renderSitemap(site), TYPES.xml);
  put("robots.txt", renderRobots(site), TYPES.txt);
  const llms = renderLlmsTxt(site);
  put("llms.txt", llms.index, TYPES.txt);
  put("llms-full.txt", llms.full, TYPES.txt);
  put(`${site.indexnowKey}.txt`, site.indexnowKey, TYPES.txt);
  put("404", renderNotFound(site), TYPES.html);
  put("410", renderGone(site), TYPES.html);

  let bytes = 0;
  for (const f of files.values()) bytes += f.body.length * 2;
  const built: Built = { key, origin, site, files, bytes };
  builds++;
  cachePut(nest.id, built);

  // Remember every served path so a later move 301s instead of 404ing.
  const known = new Set(inputs.paths.map((p) => p.path));
  void recordPaths(nest.id, site.pages, known).catch((err) => console.warn("[site] recording paths failed", err));
  // Tell IndexNow engines what changed since the last build in this process.
  if (hit && place.verified) void pingIndexNow(hit.site, site).catch((err) => console.warn("[site] IndexNow ping failed", err));
  return built;
}

let builds = 0;
/** How many full builds this process has run (tests: Host churn must not rebuild). */
export function buildCount(): number {
  return builds;
}

/** The built site for a nest by id (settings panel, export), or null when it has none. */
export async function siteForNest(nestId: string, serverOrigin: string, opts: SiteOptions = {}): Promise<SiteView | null> {
  const nest = (await siteNests()).find((n) => n.id === nestId);
  return nest ? getSite(nest, serverOrigin, opts) : null;
}

/** Placement for many nests at once (server sitemap index), without building. */
export async function placements(serverOrigin: string): Promise<Array<{ nest: SiteNest; place: Placement }>> {
  const all = await siteNests();
  const rows = await siteRowsFor(all.map((n) => n.id));
  const out: Array<{ nest: SiteNest; place: Placement }> = [];
  for (const nest of all) {
    const row = rows.get(nest.id) ?? (await getSiteRow(nest.id));
    out.push({ nest, place: await placementFor(nest, row, serverOrigin) });
  }
  return out;
}

/**
 * The whole site as static files, for any static host: `<path>.html` per page
 * (clean URLs on Cloudflare Pages, Netlify, Vercel, GitHub Pages), the
 * Markdown twins, sitemap, robots, llms.txt, 404.html and a `_redirects` file
 * with every old URL. Canonicals use the site's configured home (domain or
 * public URL), else `base`.
 */
export async function buildSiteFiles(nestId: string, serverOrigin: string): Promise<Record<string, string>> {
  const built = await siteForNest(nestId, serverOrigin.replace(/\/$/, ""), { unverifiedPublicUrl: true });
  if (!built) throw new Error(`Nest ${nestId} is not a public Reader Mode nest`);
  const out: Record<string, string> = {};
  for (const path of built.paths()) {
    const file = built.file(path)!;
    if (path === "404") out["404.html"] = file.body;
    else if (path === "410") continue;
    else if (file.type === TYPES.html) out[path ? `${path}.html` : "index.html"] = file.body;
    else out[path] = file.body;
  }
  out["_redirects"] = renderRedirectsFile(built.site);
  return out;
}
