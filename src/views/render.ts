/**
 * §1.12 view serving — server-side rendering of a resolved view. Pure.
 *
 * Everything that reaches the page is escaped here: titles, list fields,
 * table cells and callouts go through `esc`, and markdown (the view's intro,
 * md blocks) renders with raw HTML disabled. The page itself runs under
 * `script-src 'none'` (routes.ts), so even a renderer bug could not run code;
 * the only active content is each html block's frame, which loads its own
 * sandboxed response.
 */
import MarkdownIt from "markdown-it";
import type { ResolvedBlock } from "./core.js";

/** A `[[target]]` (or a node id) → the in-app address of a node the reader
 *  may see, or null. Built per request over the reader's own scope, so a
 *  target they cannot read renders as its plain label and leaks nothing. */
export type LinkResolver = (target: string) => string | null;

// `html: false` escapes raw HTML in markdown; links keep markdown-it's own
// scheme validation (no javascript:, vbscript:, file:, data: other than images).
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
markdown.linkify.set({ fuzzyLink: false });

// `[[target]]`, `[[target|label]]`, `[[target#anchor]]`: the spec's wiki-link
// form (§1.7). The resolver arrives through markdown-it's env, so one parser
// serves every request. Links open at the top level: the page is also shown
// inside the app's own frame (ViewNodePage), where a plain link would load
// the whole app inside it.
markdown.inline.ruler.before("link", "wikilink", (state, silent) => {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
  const end = src.indexOf("]]", start + 2);
  if (end < 0) return false;
  const inner = src.slice(start + 2, end);
  if (!inner.trim() || inner.includes("\n") || inner.includes("[")) return false;
  if (!silent) {
    const [rawTarget, ...rest] = inner.split(/\\?\|/);
    const target = rawTarget.split("#")[0].trim();
    const label = rest.join("|").trim() || target.split("/").pop() || target;
    const resolve = (state.env as { resolveLink?: LinkResolver } | undefined)?.resolveLink;
    const href = target && resolve ? resolve(target) : null;
    if (href) {
      const open = state.push("link_open", "a", 1);
      open.attrs = [
        ["href", href],
        ["target", "_top"],
      ];
      state.push("text", "", 0).content = label;
      state.push("link_close", "a", -1);
    } else {
      state.push("text", "", 0).content = label;
    }
  }
  state.pos = end + 2;
  return true;
});

const renderMd = (text: string, resolveLink?: LinkResolver) => markdown.render(text, { resolveLink });

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Neutral reading styles: system fonts, block spacing, bordered placeholders. */
const PAGE_CSS = `
  body{margin:0;background:#fff;color:#1c1917;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  main{max-width:960px;margin:0 auto;padding:24px 20px 48px}
  main.cn-wide{max-width:none;padding:16px 16px 40px}
  main.cn-wide>h1,main.cn-wide>.cn-intro{max-width:960px}
  a{color:#4f46e5}
  h1{font-size:1.6em;line-height:1.25;margin:0 0 .6em}
  h2,h3,h4{line-height:1.3;margin:1.4em 0 .5em}
  .cn-block{margin:0 0 20px}
  .cn-intro{margin:0 0 24px;color:#44403c}
  ul.cn-list{padding-left:1.4em;margin:0}ul.cn-list li{margin:.25em 0}
  .cn-meta{color:#78716c;font-size:.9em}
  table.cn-table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}
  .cn-table th,.cn-table td{border:1px solid #e7e5e4;padding:6px 9px;text-align:left;vertical-align:top}
  .cn-table th{background:#fafaf9}
  .cn-callout{border-left:3px solid #6366f1;background:#eef2ff;padding:10px 14px;border-radius:6px}
  .cn-callout.cn-warning{border-left-color:#d97706;background:#fffbeb}
  .cn-placeholder{border:1px dashed #d6d3d1;border-radius:8px;padding:14px 16px;color:#78716c;font-size:.92em}
  iframe.cn-frame{display:block;width:100%;min-height:420px;border:1px solid #e7e5e4;border-radius:8px;background:#fff}
  main.cn-wide iframe.cn-frame{height:calc(100vh - 32px);min-height:640px}
  details.cn-sources{margin:28px 0 0;border:1px solid #e7e5e4;border-radius:8px;padding:0 14px}
  details.cn-sources>summary{cursor:pointer;padding:10px 0;color:#57534e;font-size:.92em}
  details.cn-sources[open]>summary{border-bottom:1px solid #e7e5e4;margin-bottom:14px}
  .cn-truncated{font-size:.85em}
  pre{background:#f5f5f4;border-radius:8px;padding:12px 14px;overflow-x:auto}
  code{background:#f5f5f4;border-radius:4px;padding:.1em .3em}
`;

function shell(title: string, main: string, wide = false): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><style>${PAGE_CSS}</style></head>` +
    `<body><main${wide ? ' class="cn-wide"' : ""}>${main}</main></body></html>`
  );
}

const placeholder = (text: string) => `<div class="cn-block cn-placeholder">${esc(text)}</div>`;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return esc(v.join(", "));
  return esc(typeof v === "object" ? JSON.stringify(v) : v);
}

function listHtml(items: Record<string, unknown>[], resolveLink?: LinkResolver): string {
  if (items.length === 0) return placeholder("Nothing to show yet.");
  const li = items.map((item) => {
    const text = esc(item.title ?? item.id ?? "");
    // Members are nodes the reader may already see; link them by id.
    const href = typeof item.id === "string" && resolveLink ? resolveLink(item.id) : null;
    const label = href ? `<a href="${esc(href)}" target="_top">${text}</a>` : text;
    const extra = Object.entries(item)
      .filter(([k]) => k !== "title" && k !== "id")
      .map(([, v]) => cell(v))
      .filter(Boolean);
    return `<li>${label}${extra.length ? ` <span class="cn-meta">${extra.join(" · ")}</span>` : ""}</li>`;
  });
  return `<div class="cn-block"><ul class="cn-list">${li.join("")}</ul></div>`;
}

function tableHtml(columns: string[], rows: Record<string, unknown>[]): string {
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${columns.map((c) => `<td>${cell(r[c])}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="cn-block"><table class="cn-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

const truncatedNote = '<p class="cn-meta cn-truncated">Showing the first part only.</p>';

function blockHtml(
  b: ResolvedBlock,
  frameUrl: (blockId: string) => string,
  resolveLink?: LinkResolver,
): string {
  if (!b.ok) {
    switch (b.kind) {
      // An md block that cannot be served renders nothing: missing, denied,
      // unpublished all look the same.
      case "md":
        return "";
      case "html":
        return placeholder("This embedded page is unavailable.");
      case "list":
      case "data":
        return placeholder("This data is unavailable.");
      case "summary":
      case "table":
      case "kpi":
      case "chart":
      case "metric":
        return placeholder(`${b.kind} blocks are not supported yet.`);
      default:
        return placeholder("This block is not supported yet.");
    }
  }
  switch (b.kind) {
    case "md":
      return `<div class="cn-block cn-md">${renderMd(b.text, resolveLink)}</div>`;
    case "list":
      return listHtml(b.items, resolveLink) + (b.truncated ? truncatedNote : "");
    case "data":
      return tableHtml(b.columns, b.rows) + (b.truncated ? truncatedNote : "");
    case "callout":
      return `<aside class="cn-block cn-callout cn-${b.tone}">${esc(b.text)}</aside>`;
    case "html":
      // No allow-popups, no allow-same-origin: the frame runs on an opaque
      // origin, and its response carries the matching CSP sandbox.
      return (
        `<div class="cn-block"><iframe sandbox="allow-scripts allow-modals" src="${esc(frameUrl(b.id))}"` +
        ` class="cn-frame" title="Embedded page" loading="lazy" referrerpolicy="no-referrer"></iframe></div>`
      );
  }
}

/**
 * Blocks that exist only to feed an html block: every `list` / `data` block a
 * resolved html block names in `data_from`. Spec rule 35 makes `data_from`
 * point at EARLIER blocks, so in layout order a dashboard always sits below
 * its own raw inputs. These are sources, not content: the page moves them
 * into a collapsed section after everything else. The frame still receives
 * their data through nest-data; only where they are drawn changes.
 */
export function feedBlockIds(blocks: ResolvedBlock[]): Set<string> {
  const fed = new Set<string>();
  for (const b of blocks) if (b.ok && b.kind === "html") for (const id of b.dataFrom) fed.add(id);
  const out = new Set<string>();
  for (const b of blocks) if (fed.has(b.id) && (b.kind === "list" || b.kind === "data")) out.add(b.id);
  return out;
}

/** The member-facing view page (`…/view/hosted`). */
export function renderViewPage(r: {
  title: string;
  intro: string;
  blocks: ResolvedBlock[];
  frameUrl: (blockId: string) => string;
  /** `[[wiki-link]]` / node id → in-app URL for this reader; absent: labels only. */
  resolveLink?: LinkResolver;
  /** The layout had more blocks than were served (MAX_BLOCKS). */
  truncated?: boolean;
  /** The stored layout failed the engine's view schema; no block is served. */
  invalidLayout?: boolean;
}): string {
  const parts = [`<h1>${esc(r.title)}</h1>`];
  if (r.intro.trim()) parts.push(`<div class="cn-intro">${renderMd(r.intro, r.resolveLink)}</div>`);
  if (r.invalidLayout) parts.push(placeholder("This view's layout could not be read."));
  const feeds = feedBlockIds(r.blocks);
  const sources: string[] = [];
  for (const b of r.blocks) {
    const html = blockHtml(b, r.frameUrl, r.resolveLink);
    (feeds.has(b.id) ? sources : parts).push(html);
  }
  if (r.truncated) {
    parts.push(
      `<aside class="cn-block cn-callout cn-info">${esc("This view has more blocks than can be shown; only the first ones are displayed.")}</aside>`,
    );
  }
  if (sources.length) {
    parts.push(
      `<details class="cn-sources"><summary>Data behind this view (${sources.length} ${sources.length === 1 ? "source" : "sources"})</summary>${sources.join("")}</details>`,
    );
  }
  // A page that embeds an html block (a dashboard) gets the full width.
  const wide = r.blocks.some((b) => b.kind === "html" && b.ok);
  return shell(r.title, parts.join(""), wide);
}

/** The `/p` rendering of a published view: its own intro, and one neutral
 *  placeholder per block. Nothing here is resolved from any other node. */
export function renderPublicViewPage(r: { title: string; intro: string; blockCount: number }): string {
  const parts = [`<h1>${esc(r.title)}</h1>`];
  if (r.intro.trim()) parts.push(`<div class="cn-intro">${renderMd(r.intro)}</div>`);
  for (let i = 0; i < r.blockCount; i++) parts.push(placeholder("Available to nest members"));
  return shell(r.title, parts.join(""));
}
