/**
 * Public docs site — HTML/XML/text templates (CU-wdqcq05jhm).
 *
 * Every page is complete on its own: the article, nav, breadcrumbs, prev/next,
 * backlinks and related pages are all in the HTML, so a crawler (or an AI
 * agent that never runs JavaScript) reads exactly what a person sees. No app
 * bundle and no third-party requests: one inline stylesheet and one small
 * inline script (nav filter + copy-as-Markdown), both pinned by CSP hashes.
 */
import { createHash } from "node:crypto";
import type { GlossaryEntry, NavFolder, PageRef, Site, SitePage, TagHub } from "./build.js";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON for a <script type="application/ld+json"> block — `<` can't close the tag. */
function ldJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function css(site: Site): string {
  const b = site.nest.branding;
  const accent = b?.accent_color && HEX.test(b.accent_color) ? b.accent_color : null;
  const headerBg = b?.header_bg_color && HEX.test(b.header_bg_color) ? b.header_bg_color : null;
  const tint = b?.page_tint_color && HEX.test(b.page_tint_color) ? b.page_tint_color : null;
  return `
:root{--bg:${tint ?? "#fff"};--fg:#1c1917;--muted:#6b6560;--line:#e7e5e4;--soft:#f5f5f4;--accent:${accent ?? "#142a80"};--head:${headerBg ?? "transparent"};color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#e9e7e4;--muted:#a19d98;--line:#2a2a2e;--soft:#1c1c20;--accent:${accent ? accent : "#9db1ff"};--head:transparent;color-scheme:dark}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent)}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:8px;background:var(--bg);padding:8px;z-index:9}
header.top{border-bottom:1px solid var(--line);background:var(--head);padding:12px 24px;display:flex;align-items:center;gap:12px}
header.top .brand{display:flex;align-items:center;gap:10px;font-weight:650;color:var(--fg);text-decoration:none;font-size:17px}
header.top .brand img{height:28px;width:auto}
.layout{display:grid;grid-template-columns:260px minmax(0,1fr) 220px;gap:40px;max-width:1280px;margin:0 auto;padding:0 24px}
details.navbox{position:sticky;top:0;align-self:start;max-height:100vh;overflow-y:auto}
details.navbox summary{display:none}
nav.side{padding:28px 0;font-size:14.5px}
nav.side ul{list-style:none;margin:0;padding:0}
nav.side li{margin:1px 0}
nav.side a{display:block;padding:4px 10px;border-radius:6px;color:var(--fg);text-decoration:none;line-height:1.4}
nav.side a:hover{background:var(--soft)}
nav.side a[aria-current=page]{background:var(--soft);color:var(--accent);font-weight:600}
nav.side .folder{margin:14px 0 4px;padding:0 10px;font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
nav.side ul ul{padding-left:10px;border-left:1px solid var(--line);margin-left:10px}
nav.side input{width:100%;margin:0 0 12px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
main{min-width:0;padding:28px 0 64px}
article{max-width:72ch}
.crumbs{font-size:13.5px;color:var(--muted);margin:0 0 8px}
.crumbs a{color:var(--muted)}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;font-size:13.5px;color:var(--muted);margin:-6px 0 28px}
.meta .tags a{display:inline-block;margin-right:6px;padding:1px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted);text-decoration:none;font-size:12.5px}
.ai{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.ai a,.ai button{font:inherit;font-size:12.5px;color:var(--muted);background:none;border:1px solid var(--line);border-radius:6px;padding:2px 8px;cursor:pointer;text-decoration:none}
.ai a:hover,.ai button:hover{color:var(--accent);border-color:var(--accent)}
h1,h2,h3,h4{line-height:1.25;margin:1.8em 0 .6em;scroll-margin-top:16px}
h1{font-size:2.1em;margin-top:.2em}h2{font-size:1.5em;padding-top:.4em;border-top:1px solid var(--line)}h3{font-size:1.2em}h4{font-size:1.05em}
p,ul,ol,blockquote,table,pre,dl{margin:0 0 1.1em}
ul,ol{padding-left:1.5em}li{margin:.3em 0}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
blockquote{border-left:3px solid var(--line);margin-left:0;padding:.2em 0 .2em 1em;color:var(--muted)}
code{background:var(--soft);border-radius:4px;padding:.15em .35em;font:.9em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{background:var(--soft);border-radius:8px;padding:14px 16px;overflow-x:auto}
pre code{background:none;padding:0}
table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--soft)}
img{max-width:100%;height:auto}
a.term{text-decoration:underline dotted;text-underline-offset:3px;color:inherit}
dt{font-weight:650;margin-top:1.2em}dd{margin:.2em 0 0}
section.links{margin-top:40px;padding-top:18px;border-top:1px solid var(--line)}
section.links h2{font-size:1.05em;border:0;padding:0;margin:0 0 8px}
section.links ul{list-style:none;padding:0}section.links li{margin:6px 0}
section.links small{display:block;color:var(--muted);font-size:13px;line-height:1.45}
.pager{display:flex;justify-content:space-between;gap:16px;margin-top:40px;padding-top:20px;border-top:1px solid var(--line)}
.pager a{display:block;max-width:48%;text-decoration:none;border:1px solid var(--line);border-radius:8px;padding:10px 14px}
.pager a:hover{border-color:var(--accent)}
.pager small{display:block;color:var(--muted);font-size:12.5px}
.pager .next{margin-left:auto;text-align:right}
aside.toc{position:sticky;top:0;align-self:start;max-height:100vh;overflow-y:auto;padding:28px 0;font-size:13.5px}
aside.toc p{font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
aside.toc ul{list-style:none;margin:0;padding:0}
aside.toc li{margin:4px 0}aside.toc li.h3{padding-left:12px}
aside.toc a{color:var(--muted);text-decoration:none}aside.toc a:hover{color:var(--accent)}
footer.foot{border-top:1px solid var(--line);padding:20px 24px;font-size:13px;color:var(--muted);text-align:center}
footer.foot a{color:var(--muted)}
@media (max-width:1100px){.layout{grid-template-columns:240px minmax(0,1fr)}aside.toc{display:none}}
@media (max-width:760px){
  .layout{display:block;padding:0 16px}
  header.top{padding:12px 16px}
  details.navbox{position:static;max-height:none;overflow:visible;border-bottom:1px solid var(--line);padding:10px 0}
  details.navbox summary{display:list-item;cursor:pointer;font-weight:600}
  nav.side{padding:12px 0 0}
  h1{font-size:1.75em}
  .ai{margin-left:0}
}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
`;
}

/** Nav filter + "Copy page" (fetches the page's own .md). Static, so its CSP hash is fixed. */
const SCRIPT = `if(matchMedia('(max-width:760px)').matches)document.querySelectorAll('details.navbox').forEach(function(d){d.open=false});document.querySelectorAll('[data-filter]').forEach(function(i){i.addEventListener('input',function(){var q=i.value.trim().toLowerCase();i.closest('nav').querySelectorAll('li[data-t]').forEach(function(li){li.hidden=!!q&&li.getAttribute('data-t').indexOf(q)<0})})});document.querySelectorAll('[data-copy]').forEach(function(b){b.addEventListener('click',function(){fetch(b.getAttribute('data-copy')).then(function(r){return r.text()}).then(function(t){return navigator.clipboard.writeText(t)}).then(function(){b.textContent='Copied'},function(){b.textContent='Copy failed'})})})`;

const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

/**
 * The Content-Security-Policy for a page: only our own inline style and
 * script run (by hash — no 'unsafe-inline'), images and media over https.
 */
export function cspFor(html: string): string {
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => sha(m[1]));
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => sha(m[1]));
  return [
    "default-src 'none'",
    "img-src https: data:",
    "media-src https:",
    `style-src ${styles.join(" ") || "'none'"}`,
    `script-src ${scripts.join(" ") || "'none'"}`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function url(site: Site, path: string): string {
  return `${site.base}/${path}`;
}
export function href(site: Site, path: string): string {
  return `${site.prefix}/${path}`;
}

function navList(site: Site, folder: NavFolder, current: string | null): string {
  const items: string[] = [];
  for (const p of folder.pages) {
    const cur = p.path === current ? ' aria-current="page"' : "";
    items.push(`<li data-t="${esc(p.title.toLowerCase())}"><a href="${esc(href(site, p.path))}"${cur}>${esc(p.title)}</a></li>`);
  }
  for (const f of folder.folders) {
    items.push(`<li><div class="folder">${esc(f.name)}</div>${navList(site, f, current)}</li>`);
  }
  return `<ul>${items.join("")}</ul>`;
}

function sideNav(site: Site, current: string | null): string {
  const home = site.byPath.get("");
  const homeLink = `<li data-t="${esc((home?.title ?? "home").toLowerCase())}"><a href="${esc(href(site, ""))}"${current === "" ? ' aria-current="page"' : ""}>${esc(home?.title ?? "Home")}</a></li>`;
  const extras = [
    site.glossary.length ? `<li data-t="glossary"><a href="${esc(href(site, "glossary"))}"${current === "glossary" ? ' aria-current="page"' : ""}>Glossary</a></li>` : "",
  ].join("");
  const tree = navList(site, site.nav, current).replace(/^<ul>/, `<ul>${homeLink}`).replace(/<\/ul>$/, `${extras}</ul>`);
  return `<nav class="side" aria-label="Documentation"><input type="search" placeholder="Filter pages" aria-label="Filter pages" data-filter>${tree}</nav>`;
}

function shareImage(site: Site): string | null {
  return site.settings.og_image_url || site.nest.branding?.banner_url || site.nest.branding?.logo_url || null;
}

function organization(site: Site) {
  const s = site.settings;
  const logo = s.organization_logo_url || site.nest.branding?.logo_url || null;
  return {
    "@type": "Organization",
    name: s.organization_name || site.name,
    ...(s.organization_url ? { url: s.organization_url } : { url: url(site, "") }),
    ...(logo ? { logo } : {}),
    ...(s.same_as?.length ? { sameAs: s.same_as } : {}),
  };
}

interface ShellOpts {
  title: string;
  description: string;
  canonical: string | null;
  head?: string;
  current: string | null;
  main: string;
  toc?: string;
  noindex?: boolean;
  type?: "article" | "website";
}

function shell(site: Site, opts: ShellOpts): string {
  const s = site.settings;
  const noindex = opts.noindex || s.noindex;
  const image = shareImage(site);
  const b = site.nest.branding;
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(opts.title)}</title>`,
    `<meta name="description" content="${esc(opts.description)}">`,
    // No max-snippet cap: AI features only use pages eligible for a full snippet.
    noindex ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index, follow, max-image-preview:large">',
    opts.canonical ? `<link rel="canonical" href="${esc(opts.canonical)}">` : "",
    s.google_site_verification ? `<meta name="google-site-verification" content="${esc(s.google_site_verification)}">` : "",
    s.bing_site_verification ? `<meta name="msvalidate.01" content="${esc(s.bing_site_verification)}">` : "",
    b?.favicon_url ? `<link rel="icon" href="${esc(b.favicon_url)}">` : "",
    b?.accent_color && HEX.test(b.accent_color) ? `<meta name="theme-color" content="${esc(b.accent_color)}">` : "",
    `<meta property="og:site_name" content="${esc(site.name)}">`,
    `<meta property="og:title" content="${esc(opts.title)}">`,
    `<meta property="og:description" content="${esc(opts.description)}">`,
    opts.canonical ? `<meta property="og:url" content="${esc(opts.canonical)}">` : "",
    `<meta property="og:type" content="${opts.type ?? "article"}">`,
    `<meta property="og:locale" content="${esc((s.language || "en").replace("-", "_"))}">`,
    image ? `<meta property="og:image" content="${esc(image)}">` : "",
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
    s.twitter_site ? `<meta name="twitter:site" content="@${esc(s.twitter_site.replace(/^@/, ""))}">` : "",
    `<meta name="twitter:title" content="${esc(opts.title)}">`,
    `<meta name="twitter:description" content="${esc(opts.description)}">`,
    image ? `<meta name="twitter:image" content="${esc(image)}">` : "",
    `<link rel="sitemap" type="application/xml" href="${esc(href(site, "sitemap.xml"))}">`,
    `<link rel="help" type="text/plain" href="${esc(href(site, "llms.txt"))}" title="llms.txt">`,
    opts.head ?? "",
    `<style>${css(site)}</style>`,
  ]
    .filter(Boolean)
    .join("\n");
  const logo = b?.logo_url ? `<img src="${esc(b.logo_url)}" alt="" width="28" height="28">` : "";
  const footBits = [
    b?.footer_text ? esc(b.footer_text) : esc(site.name),
    b?.footer_link_url ? `<a href="${esc(b.footer_link_url)}" rel="noopener">${esc(b.footer_link_label || b.footer_link_url)}</a>` : "",
    `<a href="${esc(href(site, "llms.txt"))}">llms.txt</a>`,
    `<a href="${esc(`${site.serverOrigin}/nests/${site.nest.id}/mcp`)}" rel="nofollow">MCP</a>`,
    b?.hide_powered_by ? "" : `Published with <a href="https://contextnest.ai" rel="noopener">ContextNest</a>`,
  ].filter(Boolean);
  return `<!doctype html>
<html lang="${esc(s.language || "en")}">
<head>
${head}
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="top"><a class="brand" href="${esc(href(site, ""))}">${logo}${esc(site.name)}</a></header>
<div class="layout">
<details class="navbox" open><summary>Contents</summary>${sideNav(site, opts.current)}</details>
<main id="content">${opts.main}</main>
${opts.toc ?? "<div></div>"}
</div>
<footer class="foot">${footBits.join(" · ")}</footer>
<script>${SCRIPT}</script>
</body>
</html>`;
}

export function isoDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.includes("T") || iso.endsWith("Z") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function refList(site: Site, title: string, refs: PageRef[], withDescription = true): string {
  if (!refs.length) return "";
  return `<section class="links"><h2>${esc(title)}</h2><ul>${refs
    .map(
      (r) =>
        `<li><a href="${esc(href(site, r.path))}">${esc(r.title)}</a>${withDescription && r.description ? `<small>${esc(r.description)}</small>` : ""}</li>`,
    )
    .join("")}</ul></section>`;
}

/** Deep links that open the page in an AI assistant with the Markdown attached. */
function aiActions(site: Site, page: SitePage): string {
  if (site.settings.ai_actions === false) return "";
  const md = url(site, `${page.path || "index"}.md`);
  const prompt = encodeURIComponent(`Read ${md} so I can ask questions about it.`);
  return `<span class="ai"><button type="button" data-copy="${esc(href(site, `${page.path || "index"}.md`))}">Copy page</button><a href="https://chatgpt.com/?hints=search&amp;q=${prompt}" rel="nofollow noopener" target="_blank">Open in ChatGPT</a><a href="https://claude.ai/new?q=${prompt}" rel="nofollow noopener" target="_blank">Open in Claude</a></span>`;
}

export function renderPage(site: Site, page: SitePage | null): string {
  if (!page) return renderToc(site);
  const isHome = page.path === "";
  const canonical = url(site, page.path);
  const title = isHome && page.title.toLowerCase() === site.name.toLowerCase() ? site.name : `${page.title} — ${site.name}`;
  const updated = isoDate(page.updated);
  const org = organization(site);

  const crumbItems = [
    { title: site.name, path: "" as string | null },
    ...page.crumbs,
    ...(isHome ? [] : [{ title: page.title, path: page.path }]),
  ];
  const graph: Array<Record<string, unknown>> = [
    {
      "@type": "TechArticle",
      "@id": `${canonical}#article`,
      headline: page.title,
      description: page.description,
      url: canonical,
      mainEntityOfPage: canonical,
      inLanguage: site.settings.language || "en",
      ...(updated ? { dateModified: updated } : {}),
      ...(page.tags.length ? { keywords: page.tags.join(", ") } : {}),
      ...(page.tagPages.length
        ? { about: page.tagPages.map((t) => ({ "@type": "DefinedTerm", name: t.tag, url: url(site, t.path) })) }
        : {}),
      ...(page.linksTo.length ? { mentions: page.linksTo.map((r) => ({ "@type": "TechArticle", name: r.title, url: url(site, r.path) })) } : {}),
      ...(page.basedOn.length ? { isBasedOn: page.basedOn.map((r) => url(site, r.path)) } : {}),
      ...(page.related.length ? { relatedLink: page.related.map((r) => url(site, r.path)) } : {}),
      encoding: { "@type": "MediaObject", encodingFormat: "text/markdown", contentUrl: url(site, `${page.path || "index"}.md`) },
      isPartOf: { "@type": "WebSite", name: site.name, url: url(site, "") },
      publisher: org,
      author: org,
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: crumbItems
        .filter((c) => c.path != null)
        .map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.title, item: url(site, c.path!) })),
    },
  ];
  if (isHome) {
    graph.push({ "@type": "WebSite", name: site.name, url: url(site, ""), inLanguage: site.settings.language || "en", publisher: org });
    graph.push({ ...org, "@id": `${url(site, "")}#organization` });
  }

  const crumbs = isHome
    ? ""
    : `<nav class="crumbs" aria-label="Breadcrumb">${[{ title: site.name, path: "" as string | null }, ...page.crumbs]
        .map((c) => (c.path != null ? `<a href="${esc(href(site, c.path))}">${esc(c.title)}</a>` : esc(c.title)))
        .join(" / ")}</nav>`;
  const tagChips = page.tagPages.length
    ? `<span class="tags">${page.tagPages.map((t) => `<a href="${esc(href(site, t.path))}" rel="tag">${esc(t.tag)}</a>`).join("")}</span>`
    : "";
  const meta = `<div class="meta">${updated ? `<span>Updated <time datetime="${updated}">${updated.slice(0, 10)}</time></span>` : ""}${tagChips}${aiActions(site, page)}</div>`;
  const pager =
    page.prev || page.next
      ? `<nav class="pager" aria-label="Pages">${page.prev ? `<a class="prev" href="${esc(href(site, page.prev.path))}" rel="prev"><small>Previous</small>${esc(page.prev.title)}</a>` : ""}${page.next ? `<a class="next" href="${esc(href(site, page.next.path))}" rel="next"><small>Next</small>${esc(page.next.title)}</a>` : ""}</nav>`
      : "";
  const outline = page.headings.filter((h) => h.level === 2 || h.level === 3);
  const toc = outline.length
    ? `<aside class="toc" aria-label="On this page"><p>On this page</p><ul>${outline
        .map((h) => `<li class="h${h.level}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`)
        .join("")}</ul></aside>`
    : undefined;
  const semantic = [
    refList(site, "Builds on", page.basedOn),
    refList(site, "Related pages", page.related),
    refList(site, "Referenced by", page.linkedFrom, false),
  ].join("");

  return shell(site, {
    title,
    description: page.description,
    canonical,
    current: page.path,
    type: isHome ? "website" : "article",
    head: [
      updated ? `<meta property="article:modified_time" content="${updated}">` : "",
      ...page.tags.map((t) => `<meta property="article:tag" content="${esc(t)}">`),
      `<link rel="alternate" type="text/markdown" href="${esc(href(site, `${page.path || "index"}.md`))}">`,
      page.prev ? `<link rel="prev" href="${esc(url(site, page.prev.path))}">` : "",
      page.next ? `<link rel="next" href="${esc(url(site, page.next.path))}">` : "",
      `<script type="application/ld+json">${ldJson({ "@context": "https://schema.org", "@graph": graph })}</script>`,
    ]
      .filter(Boolean)
      .join("\n"),
    main: `<article>${crumbs}<h1>${esc(page.title)}</h1>${meta}${page.html}${semantic}${pager}</article>`,
    toc,
  });
}

/** The home page when the nest has no welcome/index page: a table of contents. */
function renderToc(site: Site): string {
  const section = (f: NavFolder, depth: number): string => {
    const list = f.pages.length
      ? `<ul>${f.pages.map((p) => `<li><a href="${esc(href(site, p.path))}">${esc(p.title)}</a> — ${esc(p.description)}</li>`).join("")}</ul>`
      : "";
    const tag = `h${Math.min(depth + 1, 4)}`;
    return `${depth ? `<${tag} id="${esc(f.path.replace(/\//g, "-"))}">${esc(f.name)}</${tag}>` : ""}${list}${f.folders.map((c) => section(c, depth + 1)).join("")}`;
  };
  const description = site.settings.description || site.nest.description?.trim() || `Documentation for ${site.name}.`;
  const org = organization(site);
  return shell(site, {
    title: `${site.name} — Documentation`,
    description,
    canonical: url(site, ""),
    current: "",
    type: "website",
    head: `<script type="application/ld+json">${ldJson({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: site.name, url: url(site, ""), inLanguage: site.settings.language || "en", publisher: org },
        { ...org, "@id": `${url(site, "")}#organization` },
      ],
    })}</script>`,
    main: `<article><h1>${esc(site.name)}</h1><p>${esc(description)}</p>${section(site.nav, 0)}</article>`,
  });
}

/**
 * Words a tag hub keeps upper-case: "mcp" reads "MCP", never "Mcp". Only
 * letters that are never an ordinary English word — "rest", "id" and "soc"
 * are left out, so a "rest" tag reads "Rest", not "REST".
 */
const ACRONYMS = new Set([
  "ai", "api", "cli", "sdk", "sso", "mcp", "llm", "rag", "ui", "ux", "url", "http", "https",
  "json", "yaml", "sql", "seo", "pdf", "csv", "html", "css", "jwt", "oidc", "saml", "rbac", "gdpr",
  "hipaa", "gtm", "crm", "erp", "kpi", "okr", "faq", "dns", "aws", "gcp",
]);

/** A tag as a heading: "api-design" → "API Design", "getting_started" → "Getting Started". */
export function tagTitle(tag: string): string {
  const title = tag
    .replace(/^#/, "")
    .split(/[-_\s/]+/)
    .filter(Boolean)
    .map((w) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      // A plural acronym: "apis" → "APIs", "llms" → "LLMs".
      if (lower.endsWith("s") && ACRONYMS.has(lower.slice(0, -1))) return `${lower.slice(0, -1).toUpperCase()}s`;
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(" ");
  // A tag of separators only still needs a heading.
  return title || tag;
}

/** ~155 characters, cut on a word. */
function clip(text: string, max = 155): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : max).replace(/[,;:.\s]+$/, "")}…`;
}

export function renderTagPage(site: Site, hub: TagHub): string {
  const title = tagTitle(hub.tag);
  const n = hub.pages.length;
  const count = `${n} ${n === 1 ? "page" : "pages"}`;
  // Name the topic and count its pages; lead with the glossary definition
  // when there is one, else name the first pages so no two hubs read alike.
  const names = hub.pages.slice(0, 3).map((p) => p.title);
  // The count sentence is never clipped away: a long definition is cut first.
  const tail = `${count} in ${site.name} about ${title}`;
  const description = hub.definition
    ? `${clip(`${title}: ${hub.definition.trim().replace(/[.\s]+$/, "")}.`, Math.max(60, 154 - tail.length))} ${tail}.`
    : clip(`${tail}${names.length ? `, including ${names.join(", ")}` : ""}.`);
  const canonical = url(site, hub.path);
  return shell(site, {
    title: `${title} — ${site.name}`,
    description,
    canonical,
    current: hub.path,
    type: "website",
    head: `<script type="application/ld+json">${ldJson({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage",
          name: title,
          url: canonical,
          about: { "@type": "DefinedTerm", name: title, ...(hub.definition ? { description: hub.definition } : {}) },
          hasPart: hub.pages.map((p) => ({ "@type": "TechArticle", name: p.title, url: url(site, p.path) })),
        },
      ],
    })}</script>`,
    main: `<article><nav class="crumbs" aria-label="Breadcrumb"><a href="${esc(href(site, ""))}">${esc(site.name)}</a> / Topics</nav><h1>${esc(title)}</h1>${hub.definition ? `<p>${esc(hub.definition)}</p>` : ""}<ul>${hub.pages
      .map((p) => `<li><a href="${esc(href(site, p.path))}">${esc(p.title)}</a> — ${esc(p.description)}</li>`)
      .join("")}</ul></article>`,
  });
}

export function renderGlossary(site: Site): string {
  const canonical = url(site, "glossary");
  const entry = (g: GlossaryEntry) =>
    `<dt id="${esc(g.id)}">${esc(g.term)}</dt><dd>${esc(g.definition)}${g.tagPath ? ` <a href="${esc(href(site, g.tagPath))}">Pages about ${esc(g.term)}</a>` : ""}</dd>`;
  return shell(site, {
    title: `Glossary — ${site.name}`,
    description: `Definitions of the terms used in ${site.name}.`,
    canonical,
    current: "glossary",
    type: "website",
    head: `<script type="application/ld+json">${ldJson({
      "@context": "https://schema.org",
      "@type": "DefinedTermSet",
      name: `${site.name} glossary`,
      url: canonical,
      hasDefinedTerm: site.glossary.map((g) => ({
        "@type": "DefinedTerm",
        "@id": `${canonical}#${g.id}`,
        name: g.term,
        description: g.definition,
        url: `${canonical}#${g.id}`,
      })),
    })}</script>`,
    main: `<article><h1>Glossary</h1><dl>${site.glossary.map(entry).join("")}</dl></article>`,
  });
}

export function renderNotFound(site: Site): string {
  return shell(site, {
    title: `Page not found — ${site.name}`,
    description: `This page does not exist in ${site.name}.`,
    canonical: null,
    current: null,
    noindex: true,
    main: `<article><h1>Page not found</h1><p>This page doesn't exist, or it hasn't been published yet. <a href="${esc(href(site, ""))}">Go to the start</a>, or pick a page from the list.</p></article>`,
  });
}

export function renderGone(site: Site): string {
  return shell(site, {
    title: `Page removed — ${site.name}`,
    description: `This page was removed from ${site.name}.`,
    canonical: null,
    current: null,
    noindex: true,
    main: `<article><h1>This page was removed</h1><p>It is no longer part of ${esc(site.name)}. <a href="${esc(href(site, ""))}">Go to the start</a>, or pick a page from the list.</p></article>`,
  });
}

export function renderSitemap(site: Site): string {
  if (site.settings.noindex) return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n`;
  const urls = site.pages.map((p) => {
    const lastmod = isoDate(p.updated);
    return `<url><loc>${esc(url(site, p.path))}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
  });
  if (site.homeSynthesized) urls.unshift(`<url><loc>${esc(url(site, ""))}</loc></url>`);
  for (const t of site.tags) {
    const newest = t.pages.map((p) => isoDate(p.updated)).filter(Boolean).sort().pop();
    urls.push(`<url><loc>${esc(url(site, t.path))}</loc>${newest ? `<lastmod>${newest}</lastmod>` : ""}</url>`);
  }
  if (site.glossary.length) urls.push(`<url><loc>${esc(url(site, "glossary"))}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function renderSitemapIndex(sitemaps: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemaps
    .map((s) => `<sitemap><loc>${esc(s)}</loc></sitemap>`)
    .join("\n")}\n</sitemapindex>\n`;
}

/**
 * AI crawlers by job. Search and user-triggered agents are always welcome —
 * blocking OAI-SearchBot alone drops a site from ChatGPT search answers.
 * Training crawlers follow the site's ai_training setting.
 */
export const AI_SEARCH_AGENTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Bingbot",
  "Googlebot",
  "Applebot",
  "DuckAssistBot",
];
export const AI_TRAINING_AGENTS = ["GPTBot", "ClaudeBot", "Google-Extended", "Applebot-Extended", "CCBot", "Meta-ExternalAgent"];

/** robots.txt for a site (served at its root on a docs domain, and under /d/<key>). */
export function renderRobots(site: Site): string {
  if (site.settings.noindex) return `User-agent: *\nDisallow: /\n`;
  const train = site.settings.ai_training !== false;
  const lines = [
    "# Search engines and AI answer engines: welcome.",
    `Content-Signal: search=yes, ai-input=yes, ai-train=${train ? "yes" : "no"}`,
    "",
    ...AI_SEARCH_AGENTS.map((a) => `User-agent: ${a}`),
    "Allow: /",
    "",
    ...AI_TRAINING_AGENTS.map((a) => `User-agent: ${a}`),
    train ? "Allow: /" : "Disallow: /",
    "",
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${url(site, "sitemap.xml")}`,
    "",
  ];
  return lines.join("\n");
}

/** Server-level robots.txt: the public surfaces are crawlable, the API isn't. */
export function renderServerRobots(sitemap: string, disallow: string[]): string {
  return `User-agent: *\nAllow: /\n${disallow.map((d) => `Disallow: ${d}\n`).join("")}\nSitemap: ${sitemap}\n`;
}

/** llms.txt (the index agents read first) and llms-full.txt (every page inline). */
export function renderLlmsTxt(site: Site): { index: string; full: string } {
  const summary = site.settings.description || site.nest.description?.trim() || `Documentation for ${site.name}.`;
  const mcp = `${site.serverOrigin}/nests/${site.nest.id}/mcp`;
  const lines = [
    `# ${site.name}`,
    "",
    `> ${summary}`,
    "",
    `Every page is available as Markdown at its URL + \`.md\`. The full text is at ${url(site, "llms-full.txt")}. Agents can also query this documentation over MCP (Streamable HTTP, read-only): ${mcp}`,
    "",
  ];
  const walk = (f: NavFolder, heading: string) => {
    if (f.pages.length) {
      lines.push(`## ${heading}`, "");
      for (const p of f.pages) lines.push(`- [${p.title}](${url(site, `${p.path}.md`)}): ${p.description}`);
      lines.push("");
    }
    f.folders.forEach((c) => walk(c, heading === "Docs" ? c.name : `${heading} / ${c.name}`));
  };
  const home = site.byPath.get("");
  if (home) lines.push(`- [${home.title}](${url(site, "index.md")}): ${home.description}`, "");
  walk(site.nav, "Docs");
  if (site.glossary.length) {
    lines.push("## Optional", "", `- [Glossary](${url(site, "glossary")}): definitions of ${site.glossary.length} terms`, "");
  }
  const full = [`# ${site.name}`, "", `> ${summary}`, ""];
  for (const p of site.pages) full.push(`---`, "", `Source: ${url(site, p.path)}`, "", p.markdown.trim(), "");
  if (site.glossary.length) {
    full.push("---", "", "# Glossary", "");
    for (const g of site.glossary) full.push(`**${g.term}**: ${g.definition}`, "");
  }
  return { index: lines.join("\n"), full: full.join("\n") };
}

/** `_redirects` (Netlify / Cloudflare Pages format) for a static export. */
export function renderRedirectsFile(site: Site): string {
  const lines = [...site.redirects].map(([from, to]) => `${site.prefix}/${from} ${to} 301`);
  for (const g of site.gone) lines.push(`${site.prefix}/${g} ${site.prefix}/404.html 410`);
  return `${lines.join("\n")}\n`;
}
