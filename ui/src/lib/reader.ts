/**
 * Public docs reader — navigation logic kept pure so it is testable in the
 * node env: wikilink resolution, breadcrumbs, section labels, reading order.
 */

export interface ReaderNode {
  id: string;
  title?: string;
  [key: string]: unknown;
}

/** A node id with the `nodes/` root, `.md`, and slashes normalised for comparison. */
function canonical(id: string): string {
  let s = id.trim().replace(/^\/+/, "").replace(/\.md$/i, "");
  if (!s.startsWith("nodes/")) s = `nodes/${s}`;
  return s.toLowerCase();
}

/**
 * Resolve a `[[target]]` to a node. The path is authoritative: a docs nest has
 * a dozen pages titled "Overview", so a title match is only the fallback for
 * links written as plain titles, never a rewrite of a path that does not
 * exist. A slash-less target also matches a page by its slug (`[[atoms]]` →
 * `…/selectors/atoms`) when no title matches. Returns null when nothing
 * matches — the caller says so.
 */
export function resolveWikiTarget<T extends ReaderNode>(target: string, nodes: T[]): T | null {
  const raw = target.trim();
  if (!raw) return null;
  if (raw.includes("/")) {
    const want = canonical(raw);
    const byPath = nodes.find((n) => canonical(n.id) === want);
    return byPath ?? null;
  }
  const want = raw.toLowerCase();
  return nodes.find((n) => String(n.title ?? "").toLowerCase() === want) ?? nodes.find((n) => canonical(n.id).endsWith(`/${want}`)) ?? null;
}

/** "hosted-nest" → "Hosted nest". Sentence case: a folder name is a label, not a title. */
export function humanize(slug: string): string {
  const s = slug.replace(/[-_]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Folder path → what the nav calls it. The nest root is "General". */
export function sectionLabel(folder: string): string {
  if (!folder || folder === "Root") return "General";
  return humanize(folder.split("/").filter(Boolean).pop() ?? folder);
}

/** The folders above a node, as readable crumbs — the leaf is the page title, not a crumb. */
export function breadcrumbFor(id: string): string[] {
  const parts = id.replace(/^nodes\//, "").split("/").filter(Boolean);
  return parts.slice(0, -1).map(humanize);
}

/** Within a folder an "overview"/"index"/"readme" page reads first; the rest keep their order. */
const LEAD = /^(overview|index|readme|welcome|home)$/i;
function leaf(id: string): string {
  return id.split("/").pop() ?? id;
}

/** True for the page that introduces its folder: overview/index/readme…, or a slug equal to the folder's own name (`hosted-nest/hosted-nest`). */
export function isLeadPage(node: ReaderNode, folder: string): boolean {
  const l = leaf(node.id).toLowerCase();
  const folderLeaf = (folder.split("/").filter(Boolean).pop() ?? "").toLowerCase();
  return LEAD.test(l) || LEAD.test(String(node.title ?? "")) || (!!folderLeaf && l === folderLeaf);
}

/** A folder's pages with its lead page first; the rest keep their order. */
export function orderWithinFolder<T extends ReaderNode>(folder: string, items: T[]): T[] {
  const lead = items.filter((n) => isLeadPage(n, folder));
  return [...lead, ...items.filter((n) => !lead.includes(n))];
}

export function readingOrder<T extends ReaderNode>(groups: Array<{ folder: string; items: T[] }>): T[] {
  return groups.flatMap((g) => orderWithinFolder(g.folder, g.items));
}

export function neighbours<T extends ReaderNode>(order: T[], id: string): { prev: T | null; next: T | null } {
  const i = order.findIndex((n) => n.id === id);
  if (i < 0) return { prev: null, next: null };
  return { prev: order[i - 1] ?? null, next: order[i + 1] ?? null };
}

/**
 * Docs convention: the body opens with `# Title`, repeating the title the
 * reader already set above the provenance line. Drop that one heading (and
 * only that one) when it matches; the outline never lists h1s anyway.
 */
export function stripLeadingTitle(body: string, title: string | undefined): string {
  if (!title) return body;
  const m = body.match(/^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/);
  if (!m) return body;
  const norm = (s: string) => s.replace(/[*_`]/g, "").trim().toLowerCase();
  return norm(m[1]) === norm(title) ? body.slice(m[0].length) : body;
}

/** When every group lives under one top-level folder, the nav starts inside it. */
export function commonRootFolder(groups: Array<{ folder: string }>, known: Array<{ path: string }> = []): string {
  const tops = new Set<string>();
  for (const g of groups) if (g.folder && g.folder !== "Root") tops.add(g.folder.split("/")[0]);
  for (const k of known) if (k.path) tops.add(k.path.split("/")[0]);
  const hasRootDocs = groups.some((g) => !g.folder || g.folder === "Root");
  return tops.size === 1 && !hasRootDocs ? [...tops][0] : "";
}

/**
 * What the page is called on screen. The node title wins — unless it is one
 * of the generic lead names ("Overview", "Welcome", "Index"…) and the body
 * opens with its own H1, which is then the real name ("Selectors").
 */
export function displayTitle(node: { id: string; title?: string } | null | undefined, body: string | undefined): string {
  if (!node) return "";
  const title = String(node.title ?? "").trim() || leaf(node.id);
  if (!body || !LEAD.test(title)) return title;
  const m = body.match(/^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/);
  return m ? m[1].replace(/[*_`]/g, "").trim() : title;
}

/** Every folder above a node, shallowest first: `docs`, `docs/platform`, `docs/platform/plugins`. */
export function ancestorsOf(id: string): string[] {
  const segs = id.replace(/^nodes\//, "").split("/").filter(Boolean).slice(0, -1);
  return segs.map((_, i) => segs.slice(0, i + 1).join("/"));
}
