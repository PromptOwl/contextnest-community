/**
 * Public docs site — HTML/XML/text templates (CU-wdqcq05jhm).
 *
 * Every page is complete on its own: the article, the nav, breadcrumbs and
 * prev/next are all in the HTML, so a crawler (or an AI agent that never runs
 * JavaScript) reads exactly what a person sees. No app bundle, no external
 * requests: one inline stylesheet and a few lines of optional script for the
 * nav filter.
 */
import type { NavFolder, Site, SitePage } from "./build.js";

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

const CSS = `
:root{--bg:#fff;--fg:#1c1917;--muted:#6b6560;--line:#e7e5e4;--soft:#f5f5f4;--accent:#142a80;--accent-fg:#142a80;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--fg:#e9e7e4;--muted:#a19d98;--line:#2a2a2e;--soft:#1c1c20;--accent:#9db1ff;--accent-fg:#9db1ff;color-scheme:dark}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent)}
.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:8px;background:var(--bg);padding:8px;z-index:9}
header.top{border-bottom:1px solid var(--line);padding:14px 24px;display:flex;align-items:center;gap:16px}
header.top .brand{font-weight:650;color:var(--fg);text-decoration:none;font-size:17px}
.layout{display:grid;grid-template-columns:260px minmax(0,1fr) 220px;gap:40px;max-width:1280px;margin:0 auto;padding:0 24px}
nav.side{position:sticky;top:0;align-self:start;max-height:100vh;overflow-y:auto;padding:28px 0;font-size:14.5px}
nav.side ul{list-style:none;margin:0;padding:0}
nav.side li{margin:1px 0}
nav.side a{display:block;padding:4px 10px;border-radius:6px;color:var(--fg);text-decoration:none;line-height:1.4}
nav.side a:hover{background:var(--soft)}
nav.side a[aria-current=page]{background:var(--soft);color:var(--accent-fg);font-weight:600}
nav.side .folder{margin:14px 0 4px;padding:0 10px;font-size:12px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
nav.side ul ul{padding-left:10px;border-left:1px solid var(--line);margin-left:10px}
nav.side input{width:100%;margin:0 0 12px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
main{min-width:0;padding:28px 0 64px}
article{max-width:72ch}
.crumbs{font-size:13.5px;color:var(--muted);margin:0 0 8px}
.crumbs a{color:var(--muted)}
.meta{font-size:13.5px;color:var(--muted);margin:-6px 0 28px}
h1,h2,h3,h4{line-height:1.25;margin:1.8em 0 .6em;scroll-margin-top:16px}
h1{font-size:2.1em;margin-top:.2em}h2{font-size:1.5em;padding-top:.4em;border-top:1px solid var(--line)}h3{font-size:1.2em}h4{font-size:1.05em}
p,ul,ol,blockquote,table,pre{margin:0 0 1.1em}
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
.pager{display:flex;justify-content:space-between;gap:16px;margin-top:48px;padding-top:20px;border-top:1px solid var(--line)}
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
details.mnav{display:none}
@media (max-width:1100px){.layout{grid-template-columns:240px minmax(0,1fr)}aside.toc{display:none}}
@media (max-width:760px){
  .layout{display:block;padding:0 16px}
  header.top{padding:12px 16px}
  nav.side{display:none}
  details.mnav{display:block;border-bottom:1px solid var(--line);padding:10px 16px}
  details.mnav summary{cursor:pointer;font-weight:600}
  details.mnav nav.side{display:block;position:static;max-height:none;padding:12px 0 0}
  h1{font-size:1.75em}
}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
`;

const FILTER_JS = `document.querySelectorAll('[data-filter]').forEach(function(i){i.addEventListener('input',function(){var q=i.value.trim().toLowerCase();i.closest('nav').querySelectorAll('li[data-t]').forEach(function(li){li.hidden=!!q&&li.getAttribute('data-t').indexOf(q)<0})})})`;

function url(site: Site, path: string): string {
  return `${site.base}/${path}`;
}
function href(site: Site, path: string): string {
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
  const tree = navList(site, site.nav, current).replace(/^<ul>/, `<ul>${homeLink}`);
  return `<nav class="side" aria-label="Documentation"><input type="search" placeholder="Filter pages" aria-label="Filter pages" data-filter>${tree}</nav>`;
}

function shell(site: Site, opts: {
  title: string;
  description: string;
  canonical: string | null;
  head?: string;
  current: string | null;
  main: string;
  toc?: string;
  noindex?: boolean;
}): string {
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(opts.title)}</title>`,
    `<meta name="description" content="${esc(opts.description)}">`,
    opts.noindex ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">',
    opts.canonical ? `<link rel="canonical" href="${esc(opts.canonical)}">` : "",
    `<meta property="og:site_name" content="${esc(site.nest.name)}">`,
    `<meta property="og:title" content="${esc(opts.title)}">`,
    `<meta property="og:description" content="${esc(opts.description)}">`,
    opts.canonical ? `<meta property="og:url" content="${esc(opts.canonical)}">` : "",
    '<meta property="og:type" content="article">',
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${esc(opts.title)}">`,
    `<meta name="twitter:description" content="${esc(opts.description)}">`,
    `<link rel="sitemap" type="application/xml" href="${esc(href(site, "sitemap.xml"))}">`,
    opts.head ?? "",
    `<style>${CSS}</style>`,
  ]
    .filter(Boolean)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
${head}
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="top"><a class="brand" href="${esc(href(site, ""))}">${esc(site.nest.name)}</a></header>
<details class="mnav"><summary>Contents</summary>${sideNav(site, opts.current)}</details>
<div class="layout">
${sideNav(site, opts.current)}
<main id="content">${opts.main}</main>
${opts.toc ?? "<div></div>"}
</div>
<footer class="foot">${esc(site.nest.name)} · Published with <a href="https://contextnest.ai" rel="noopener">ContextNest</a></footer>
<script>${FILTER_JS}</script>
</body>
</html>`;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.includes("T") || iso.endsWith("Z") ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function renderPage(site: Site, page: SitePage | null): string {
  if (!page) return renderToc(site);
  const isHome = page.path === "";
  const canonical = url(site, page.path);
  const title = isHome ? `${page.title} — ${site.nest.name}` : `${page.title} — ${site.nest.name}`;
  const updated = formatDate(page.updated);

  const crumbItems = [
    { title: site.nest.name, path: "" as string | null },
    ...page.crumbs,
    ...(isHome ? [] : [{ title: page.title, path: page.path }]),
  ];
  const ld = [
    {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: page.title,
      description: page.description,
      url: canonical,
      mainEntityOfPage: canonical,
      ...(updated ? { dateModified: updated } : {}),
      ...(page.tags.length ? { keywords: page.tags.join(", ") } : {}),
      isPartOf: { "@type": "WebSite", name: site.nest.name, url: url(site, "") },
      publisher: { "@type": "Organization", name: site.nest.name },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: crumbItems
        .filter((c) => c.path != null)
        .map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.title, item: url(site, c.path!) })),
    },
  ];
  if (isHome) {
    ld.push({ "@context": "https://schema.org", "@type": "WebSite", name: site.nest.name, url: url(site, "") } as any);
  }

  const crumbs = isHome
    ? ""
    : `<nav class="crumbs" aria-label="Breadcrumb">${[{ title: site.nest.name, path: "" as string | null }, ...page.crumbs]
        .map((c) => (c.path != null ? `<a href="${esc(href(site, c.path))}">${esc(c.title)}</a>` : esc(c.title)))
        .join(" / ")}</nav>`;
  const meta = updated ? `<p class="meta">Updated <time datetime="${updated}">${updated.slice(0, 10)}</time></p>` : "";
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

  return shell(site, {
    title,
    description: page.description,
    canonical,
    current: page.path,
    head: [
      updated ? `<meta property="article:modified_time" content="${updated}">` : "",
      `<link rel="alternate" type="text/markdown" href="${esc(href(site, `${page.path || "index"}.md`))}">`,
      page.prev ? `<link rel="prev" href="${esc(url(site, page.prev.path))}">` : "",
      page.next ? `<link rel="next" href="${esc(url(site, page.next.path))}">` : "",
      `<script type="application/ld+json">${ldJson(ld)}</script>`,
    ]
      .filter(Boolean)
      .join("\n"),
    main: `<article>${crumbs}<h1>${esc(page.title)}</h1>${meta}${page.html}${pager}</article>`,
    toc,
  });
}

/** The home page when the nest has no welcome/index page: a table of contents. */
function renderToc(site: Site): string {
  const section = (f: NavFolder, depth: number): string => {
    const list = f.pages.length
      ? `<ul>${f.pages.map((p) => `<li><a href="${esc(href(site, p.path))}">${esc(p.title)}</a> — ${esc(p.description)}</li>`).join("")}</ul>`
      : "";
    const tag = `h${Math.min(depth + 2, 4)}`;
    return `${depth ? `<${tag} id="${esc(f.path.replace(/\//g, "-"))}">${esc(f.name)}</${tag}>` : ""}${list}${f.folders.map((c) => section(c, depth + 1)).join("")}`;
  };
  const description = site.nest.description?.trim() || `Documentation for ${site.nest.name}.`;
  return shell(site, {
    title: `${site.nest.name} — Documentation`,
    description,
    canonical: url(site, ""),
    current: "",
    head: `<script type="application/ld+json">${ldJson({ "@context": "https://schema.org", "@type": "WebSite", name: site.nest.name, url: url(site, "") })}</script>`,
    main: `<article><h1>${esc(site.nest.name)}</h1><p>${esc(description)}</p>${section(site.nav, 0)}</article>`,
  });
}

export function renderNotFound(site: Site): string {
  return shell(site, {
    title: `Page not found — ${site.nest.name}`,
    description: `This page does not exist in ${site.nest.name}.`,
    canonical: null,
    current: null,
    noindex: true,
    main: `<article><h1>Page not found</h1><p>This page doesn't exist, or it hasn't been published yet. <a href="${esc(href(site, ""))}">Go to the start</a>, or pick a page from the list.</p></article>`,
  });
}

export function renderSitemap(site: Site): string {
  const urls = site.pages.map((p) => {
    const lastmod = formatDate(p.updated);
    return `<url><loc>${esc(url(site, p.path))}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
  });
  if (site.homeSynthesized) urls.unshift(`<url><loc>${esc(url(site, ""))}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function renderSitemapIndex(sitemaps: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemaps
    .map((s) => `<sitemap><loc>${esc(s)}</loc></sitemap>`)
    .join("\n")}\n</sitemapindex>\n`;
}

/** robots.txt — everything public is crawlable, AI crawlers included, on purpose. */
export function renderRobots(sitemap: string, disallow: string[] = []): string {
  return `User-agent: *\nAllow: /\n${disallow.map((d) => `Disallow: ${d}\n`).join("")}\nSitemap: ${sitemap}\n`;
}

/** llms.txt (the index agents read first) and llms-full.txt (every page inline). */
export function renderLlmsTxt(site: Site): { index: string; full: string } {
  const summary = site.nest.description?.trim() || `Documentation for ${site.nest.name}.`;
  const lines = [`# ${site.nest.name}`, "", `> ${summary}`, ""];
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
  const full = [`# ${site.nest.name}`, "", `> ${summary}`, ""];
  for (const p of site.pages) full.push(`---`, "", `Source: ${url(site, p.path)}`, "", p.markdown.trim(), "");
  return { index: lines.join("\n"), full: full.join("\n") };
}
