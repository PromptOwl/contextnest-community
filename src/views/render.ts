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
import { WRITE_BRIDGE_JS } from "./write.js";

// `html: false` escapes raw HTML in markdown; links keep markdown-it's own
// scheme validation (no javascript:, vbscript:, file:, data: other than images).
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

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
  iframe.cn-frame{width:100%;min-height:420px;border:1px solid #e7e5e4;border-radius:8px;background:#fff}
  .cn-truncated{font-size:.85em}
  pre{background:#f5f5f4;border-radius:8px;padding:12px 14px;overflow-x:auto}
  code{background:#f5f5f4;border-radius:4px;padding:.1em .3em}
`;

function shell(title: string, main: string, tail = ""): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><style>${PAGE_CSS}</style></head>` +
    `<body><main>${main}</main>${tail}</body></html>`
  );
}

const placeholder = (text: string) => `<div class="cn-block cn-placeholder">${esc(text)}</div>`;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return esc(v.join(", "));
  return esc(typeof v === "object" ? JSON.stringify(v) : v);
}

function listHtml(items: Record<string, unknown>[]): string {
  if (items.length === 0) return placeholder("Nothing to show yet.");
  const li = items.map((item) => {
    const label = item.title ?? item.id ?? "";
    const extra = Object.entries(item)
      .filter(([k]) => k !== "title" && k !== "id")
      .map(([, v]) => cell(v))
      .filter(Boolean);
    return `<li>${esc(label)}${extra.length ? ` <span class="cn-meta">${extra.join(" · ")}</span>` : ""}</li>`;
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

function blockHtml(b: ResolvedBlock, frameUrl: (blockId: string) => string, addressable = false): string {
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
      return `<div class="cn-block cn-md">${markdown.render(b.text)}</div>`;
    case "list":
      return listHtml(b.items) + (b.truncated ? truncatedNote : "");
    case "data":
      return tableHtml(b.columns, b.rows) + (b.truncated ? truncatedNote : "");
    case "callout":
      return `<aside class="cn-block cn-callout cn-${b.tone}">${esc(b.text)}</aside>`;
    case "html":
      // No allow-popups, no allow-same-origin: the frame runs on an opaque
      // origin, and its response carries the matching CSP sandbox.
      return (
        `<div class="cn-block"><iframe sandbox="allow-scripts allow-modals" src="${esc(frameUrl(b.id))}"` +
        // The write bridge finds a message's frame by this attribute (view
        // write-back); present only on pages that carry the bridge.
        (addressable ? ` data-cn-block="${esc(b.id)}"` : "") +
        ` class="cn-frame" title="Embedded page" loading="lazy" referrerpolicy="no-referrer"></iframe></div>`
      );
  }
}

/** The member-facing view page (`…/view/hosted`). */
export function renderViewPage(r: {
  title: string;
  intro: string;
  blocks: ResolvedBlock[];
  frameUrl: (blockId: string) => string;
  /** The layout had more blocks than were served (MAX_BLOCKS). */
  truncated?: boolean;
  /** The stored layout failed the engine's view schema; no block is served. */
  invalidLayout?: boolean;
  /** View write-back: the bridge's config JSON (already escaped for a
   *  <script> element, see write.ts). When set, frames carry their block id
   *  and the page ends with the config and the bridge; the route must serve
   *  it under withWriteBridge(VIEW_PAGE_CSP). Unset, the page is unchanged. */
  writeConfigJson?: string;
}): string {
  const parts = [`<h1>${esc(r.title)}</h1>`];
  if (r.intro.trim()) parts.push(`<div class="cn-intro">${markdown.render(r.intro)}</div>`);
  if (r.invalidLayout) parts.push(placeholder("This view's layout could not be read."));
  const writes = r.writeConfigJson !== undefined;
  for (const b of r.blocks) parts.push(blockHtml(b, r.frameUrl, writes));
  if (r.truncated) {
    parts.push(
      `<aside class="cn-block cn-callout cn-info">${esc("This view has more blocks than can be shown; only the first ones are displayed.")}</aside>`,
    );
  }
  const tail = writes
    ? `<script type="application/json" id="cn-write-config">${r.writeConfigJson}</script><script>${WRITE_BRIDGE_JS}</script>`
    : "";
  return shell(r.title, parts.join(""), tail);
}

/** The `/p` rendering of a published view: its own intro, and one neutral
 *  placeholder per block. Nothing here is resolved from any other node. */
export function renderPublicViewPage(r: { title: string; intro: string; blockCount: number }): string {
  const parts = [`<h1>${esc(r.title)}</h1>`];
  if (r.intro.trim()) parts.push(`<div class="cn-intro">${markdown.render(r.intro)}</div>`);
  for (let i = 0; i < r.blockCount; i++) parts.push(placeholder("Available to nest members"));
  return shell(r.title, parts.join(""));
}
