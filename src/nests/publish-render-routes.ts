/**
 * Public render surface for published documents — mounted at top-level `/p`,
 * OUTSIDE the /nests auth chain, so it is reachable with no account.
 *
 *   GET  /p/:slug           → the document, a gate form, or (when comments are
 *                             on) the reader shell that frames the document
 *   GET  /p/:slug/view      → the document itself, always sandboxed
 *   POST /p/:slug/gate      → submit a code, or request a magic link by email
 *   GET  /p/:slug/verify    → consume a magic link → set session cookie → open
 *   POST /p/:slug/comments  → file a comment (JSON), from the shell's modal
 *
 * The published document itself is served under the strict artifact sandbox
 * (opaque origin, no host cookies, no network) — the same policy the /hosted
 * artifact viewer uses. Our own chrome can never live inside it: the sandbox
 * blocks forms and network calls, and a popup opened from it INHERITS those
 * flags. So anything interactive (the gate form, the comment modal) is ordinary
 * HTML on a separate page or on the shell that frames the document.
 */
import { Hono } from "hono";
import MarkdownIt from "markdown-it";
import { normalizeEmail } from "../shared/email.js";
import { isEmailish } from "../config.js";
import { applyArtifactSandboxHeaders, isHtmlBody } from "../shared/artifact-sandbox.js";
import { requestBaseUrl } from "../shared/base-url.js";
import { isSecureRequest } from "../auth/sessions.js";
import { sendEmailToRecipient } from "../notify/email.js";
import { readArtifact, createThread } from "../annotations/service.js";
import { renderPublicViewPage } from "../views/render.js";
import { readViewVersion } from "../views/deps.js";
import { tryConsume } from "../shared/rate-limit.js";
import { clientIp } from "../shared/request-ip.js";
import * as publish from "./publish-service.js";
import type { PublishRow } from "./publish-service.js";
import { getDb } from "../db/client.js";
import { resolveNestPath } from "../shared/paths.js";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  cssUrl,
  nestAssetName,
  parseStoredBranding,
  publishBrandCssVars,
  type NestBranding,
} from "../shared/branding.js";

export const publishRenderRoutes = new Hono();

const SESSION_TTL_SECONDS = 24 * 60 * 60;

// Gate attempts per link per IP. Loose enough that a room full of people
// sharing one NAT can all type the passcode, tight enough that neither
// exhaustive guessing nor bulk mailing is practical.
const GATE_LIMIT = { max: 10, windowMs: 10 * 60_000 };

// Comments are an anonymous write path, so they get their own (tighter) clamp.
const COMMENT_LIMIT = { max: 5, windowMs: 10 * 60_000 };
const COMMENT_MAX_CHARS = 4000;

// Markdown nodes are rendered server-side so a published document reads like the
// editor rather than as raw source. `html: false` keeps inline HTML escaped —
// belt and braces, since the page already runs under the artifact sandbox.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** Reader styling for a rendered markdown document: one column, generous
 *  measure, and the same indigo headings the app uses. */
const PROSE_CSS = `
  body{margin:0;background:#fff;color:#1c1917;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  main{max-width:820px;margin:0 auto;padding:48px 24px}
  h1,h2,h3,h4{color:#142a80;line-height:1.25;margin:1.8em 0 .6em}
  h1{font-size:2em;margin-top:0}h2{font-size:1.5em}h3{font-size:1.2em}h4{font-size:1.05em}
  p,ul,ol,blockquote,table{margin:0 0 1.1em}
  ul,ol{padding-left:1.5em}li{margin:.3em 0}
  a{color:#142a80}
  hr{border:0;border-top:1px solid #e7e5e4;margin:2em 0}
  blockquote{border-left:3px solid #d6d3d1;margin-left:0;padding:.2em 0 .2em 1em;color:#57534e}
  code{background:#f5f5f4;border-radius:4px;padding:.15em .35em;font:.9em/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  pre{background:#f5f5f4;border-radius:9px;padding:14px 16px;overflow-x:auto}
  pre code{background:none;padding:0}
  table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}
  th,td{border:1px solid #e7e5e4;padding:8px 10px;text-align:left}
  th{background:#fafaf9}
  img{max-width:100%}
`;

function cookieName(slug: string): string {
  return `cnp_${slug}`;
}

function readCookie(c: any, name: string): string | null {
  const raw = c.req.header("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return null;
}

function setSessionCookie(c: any, slug: string, token: string): void {
  const parts = [
    `${cookieName(slug)}=${encodeURIComponent(token)}`,
    "HttpOnly",
    `Path=/p/${slug}`,
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (isSecureRequest(c)) parts.push("Secure");
  c.header("Set-Cookie", parts.join("; "));
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Per-nest branding (CU-wdqcq02ptm) ──────────────────────────────────────
//
// Every /p page runs under a CSP that allows no external images: the document
// view is the artifact sandbox (`img-src data: blob:`), the comment shell is
// `default-src 'none'`. Branding does not loosen either. A logo/banner/favicon
// uploaded to the nest is read from disk and INLINED as a `data:` URI (already
// permitted), so it also works for a publish of a private nest whose assets an
// anonymous viewer could not fetch. An external https image is simply not
// rendered here: allowing `img-src https:` on the sandboxed document would also
// let the published markdown's own `![](https://…)` images load — turning
// every public view into a third-party beacon, which the sandbox exists to stop.
// The SPA reader (no such CSP) does show https images.

interface PublishBrand {
  b: NestBranding;
  logo: string | null;
  banner: string | null;
  favicon: string | null;
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
// Inline caps: a data: URI rides every page view, so keep it to what a logo or
// a banner reasonably needs. Anything larger renders without the image.
const INLINE_CAP = { logo: 512 * 1024, favicon: 256 * 1024, banner: 2 * 1024 * 1024 } as const;
// Asset names are uuid-unique and never rewritten, so caching the encoded
// data: URI is safe. The cache is an LRU bounded by total size (Map insertion
// order = recency), not entry count: a handful of 2 MB banners must not be
// able to pin hundreds of MB. Misses (missing / oversized) are cached as null.
const INLINE_CACHE_MAX_CHARS = 24 * 1024 * 1024;
const inlineCache = new Map<string, string | null>();
let inlineCacheChars = 0;

function cacheGet(key: string): string | null | undefined {
  if (!inlineCache.has(key)) return undefined;
  const v = inlineCache.get(key)!;
  inlineCache.delete(key); // refresh recency
  inlineCache.set(key, v);
  return v;
}

function cachePut(key: string, v: string | null): void {
  const size = v?.length ?? 0;
  if (size > INLINE_CACHE_MAX_CHARS) return;
  // Two concurrent misses can put the same key — don't count it twice.
  inlineCacheChars -= inlineCache.get(key)?.length ?? 0;
  inlineCache.set(key, v);
  inlineCacheChars += size;
  for (const [k, old] of inlineCache) {
    if (inlineCacheChars <= INLINE_CACHE_MAX_CHARS && inlineCache.size <= 512) break;
    inlineCache.delete(k);
    inlineCacheChars -= old?.length ?? 0;
  }
}

async function inlineAsset(nestId: string, url: string | null | undefined, cap: number): Promise<string | null> {
  if (!url) return null;
  const name = nestAssetName(url, nestId);
  if (!name) return null; // external https image — not rendered on /p (see above)
  const key = `${nestId}/${name}/${cap}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  let out: string | null = null;
  try {
    const path = join(resolveNestPath(nestId), "assets", name);
    // Size check BEFORE reading: an oversized asset (up to the 10 MB upload
    // cap) is skipped without ever being loaded into memory.
    if ((await stat(path)).size <= cap) {
      const mime = IMAGE_MIME[name.split(".").pop()!.toLowerCase()];
      if (mime) out = `data:${mime};base64,${(await readFile(path)).toString("base64")}`;
    }
  } catch {
    // Not cached: a transient EMFILE/EBUSY would otherwise hide the image until restart.
    return null;
  }
  cachePut(key, out);
  return out;
}

/** The nest's branding for a publish, or null when it has none — in which case
 *  every page below renders byte-for-byte as it did before branding existed. */
async function loadBrand(row: PublishRow): Promise<PublishBrand | null> {
  let b: NestBranding | null = null;
  try {
    // One column, not the whole nest row — this runs on every /p view.
    const r = (await getDb().get("SELECT branding_json FROM nests WHERE id = ?", [row.nest_id])) as
      | { branding_json: string | null }
      | undefined;
    b = parseStoredBranding(r?.branding_json, row.nest_id);
  } catch {
    b = null;
  }
  if (!b) return null;
  const [logo, banner, favicon] = await Promise.all([
    inlineAsset(row.nest_id, b.logo_url, INLINE_CAP.logo),
    inlineAsset(row.nest_id, b.banner_url, INLINE_CAP.banner),
    inlineAsset(row.nest_id, b.favicon_url, INLINE_CAP.favicon),
  ]);
  return { b, logo, banner, favicon };
}

const BRAND_CSS = `
  .cn-brand{display:flex;align-items:center;gap:12px;padding:12px 24px;background:var(--cn-header-bg,#fff);color:var(--cn-header-fg,#1c1917);border-bottom:1px solid rgba(0,0,0,.08);font:600 16px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .cn-brand img{height:32px;width:auto;max-width:160px;object-fit:contain}
  .cn-brand span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cn-hero{position:relative;min-height:120px;max-height:220px;height:28vw;display:flex;flex-direction:column;justify-content:flex-end;padding:20px 24px;box-sizing:border-box;background:var(--cn-accent,#142a80) center/cover no-repeat;color:var(--cn-accent-fg,#fff);overflow:hidden}
  .cn-hero.has-img{color:#fff}
  .cn-hero.has-img::before{content:"";position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.62),rgba(0,0,0,.08))}
  .cn-hero *{position:relative;margin:0;max-width:820px}
  .cn-hero strong{display:block;font:700 clamp(20px,4vw,30px)/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .cn-hero p{margin-top:6px;font-size:15px;opacity:.92}
  .cn-foot{max-width:820px;margin:0 auto;padding:20px 24px 40px;border-top:1px solid #e7e5e4;color:#78716c;font-size:13px;display:flex;flex-wrap:wrap;gap:6px 16px}
  .cn-foot a{color:var(--cn-accent-text,#142a80)}
`;

/** `<head>` additions: the validated color variables, brand CSS, favicon. */
function brandHead(brand: PublishBrand | null, extraCss = ""): string {
  if (!brand) return "";
  const icon = brand.favicon ? `<link rel="icon" href="${esc(brand.favicon)}">` : "";
  return `<style>${publishBrandCssVars(brand.b)}${BRAND_CSS}${extraCss}</style>${icon}`;
}

/** The branded top bar: logo + site title. Empty when neither is set. */
function brandBar(brand: PublishBrand | null): string {
  if (!brand) return "";
  const title = brand.b.site_title ? `<span>${esc(brand.b.site_title)}</span>` : "";
  const logo = brand.logo ? `<img src="${esc(brand.logo)}" alt="">` : "";
  if (!title && !logo) return "";
  return `<header class="cn-brand">${logo}${title}</header>`;
}

function brandHero(brand: PublishBrand | null): string {
  if (!brand) return "";
  const { banner_headline: h, banner_subtext: sub } = brand.b;
  if (!brand.banner && !h) return "";
  const style = brand.banner ? ` style="background-image:${esc(cssUrl(brand.banner))}"` : "";
  const cls = brand.banner ? "cn-hero has-img" : "cn-hero";
  return `<div class="${cls}"${style}>${h ? `<strong>${esc(h)}</strong>` : ""}${sub ? `<p>${esc(sub)}</p>` : ""}</div>`;
}

function brandFooter(brand: PublishBrand | null): string {
  if (!brand) return "";
  const { footer_text: text, footer_link_url: href, footer_link_label: label } = brand.b;
  const parts: string[] = [];
  if (text) parts.push(`<span>${esc(text)}</span>`);
  if (href) parts.push(`<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${esc(label || href)}</a>`);
  if (!brand.b.hide_powered_by) parts.push(`<span>Secured by PromptOwl · ContextNest</span>`);
  return parts.length ? `<footer class="cn-foot">${parts.join("")}</footer>` : "";
}

/**
 * The no-download overlay: everything a browser lets us refuse.
 *
 * READ THIS BEFORE PROMISING ANYTHING. The document has already been delivered
 * to the reader's machine by the time any of this runs, so none of it is
 * protection — a screenshot, DevTools, "Save page as" from the browser menu, or
 * plain `curl` on the URL all still return the content. What it does is close
 * every path an ordinary reader would reach by reflex: selection, copy, cut,
 * drag, right-click, print, and the Ctrl-key shortcuts for save/print/copy/
 * source. Determined extraction is not in scope for CSS and JavaScript, and
 * cannot be. Identify the viewer (email or invite gate) and watermark the page
 * if the content genuinely matters — attribution deters where obstruction does
 * not.
 */
const NO_DOWNLOAD_CSS = `<style>
  @media print{html,body{display:none !important}}
  html,body{-webkit-user-select:none;-ms-user-select:none;user-select:none}
  img,a,svg,canvas{-webkit-user-drag:none;user-drag:none}
</style>`;

/** The shell only ever holds the comment modal, so it gets the print blank and
 *  nothing else — blocking selection here would stop a reader typing a comment,
 *  and the document's own copy guards live inside the frame. */
const SHELL_PRINT_BLANK = `<style>@media print{html,body{display:none !important}}</style>`;

const NO_DOWNLOAD_SCRIPT = `<script>
  (function () {
    function stop(e) { e.preventDefault(); return false; }
    ["contextmenu", "copy", "cut", "dragstart", "selectstart"].forEach(function (evt) {
      document.addEventListener(evt, stop, { capture: true });
    });
    document.addEventListener("keydown", function (e) {
      var k = (e.key || "").toLowerCase();
      // Save, print, copy, cut, select-all, view-source.
      if ((e.ctrlKey || e.metaKey) && ["s", "p", "c", "x", "a", "u"].indexOf(k) !== -1) return stop(e);
      // DevTools. Blocking these is courtesy at best — the browser menu still
      // opens them — but it stops the reflex.
      if (k === "f12") return stop(e);
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && ["i", "j", "c"].indexOf(k) !== -1) return stop(e);
    }, { capture: true });
    // Belt and braces with the print stylesheet, for engines that ignore it.
    window.addEventListener("beforeprint", function () { document.body.style.display = "none"; });
    window.addEventListener("afterprint", function () { document.body.style.display = ""; });
  })();
</script>`;

/** The viewer overlays: a watermark stamping the viewer's email across the page,
 *  and a print-blank for no-download. Both are deterrents against casual copying,
 *  never enforcement — anything a browser renders can be screenshotted. The
 *  watermark needs an identified viewer, so it is a no-op on public/code gates. */
function overlayMarkup(row: PublishRow, viewerEmail: string | null): string {
  const parts: string[] = [];
  if (row.no_download === 1) {
    parts.push(NO_DOWNLOAD_CSS, NO_DOWNLOAD_SCRIPT);
  }
  if (row.watermark === 1 && viewerEmail) {
    parts.push(
      `<style>#cn-watermark{position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:hidden;display:flex;align-items:center;justify-content:center}` +
        `#cn-watermark span{font:700 42px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:rgba(20,42,128,.10);transform:rotate(-24deg);white-space:nowrap}</style>` +
        `<div id="cn-watermark" aria-hidden="true"><span>${esc(viewerEmail)}</span></div>`,
    );
  }
  return parts.join("");
}

/** The document's title, for the reader shell's tab label. Falls back to the
 *  node id rather than failing the page over a label. */
async function publishedTitle(row: PublishRow): Promise<string> {
  try {
    return (await readArtifact(row.nest_id, row.node_id)).title || row.node_id;
  } catch {
    return row.node_id;
  }
}

/** Splice the overlays in just before `</body>` so they sit above the document,
 *  falling back to an append for bodies that ship no closing tag. */
function withOverlays(html: string, extra: string): string {
  if (!extra) return html;
  const at = html.toLowerCase().lastIndexOf("</body>");
  return at === -1 ? html + extra : html.slice(0, at) + extra + html.slice(at);
}

/** Serve the published document body. HTML/artifact bodies render as-is under
 *  the sandbox; other node types get a minimal readable shell (rich markdown
 *  rendering is a follow-up).
 *
 *  Served through `readArtifact`, the same reader the /hosted viewer uses, so a
 *  public link shows the APPROVED version. Reading the live body here would put
 *  an in-progress edit on the open web the moment it was saved — ungoverned
 *  content, from the surface whose whole premise is governance. It also gives us
 *  readArtifact's fence normalization for free (a fenced artifact body would
 *  otherwise render as literal text). */
async function renderPublished(c: any, row: PublishRow, viewerEmail: string | null) {
  let artifact: Awaited<ReturnType<typeof readArtifact>>;
  try {
    artifact = await readArtifact(row.nest_id, row.node_id);
  } catch {
    // The source node moved or was removed since it was published. Deliberately
    // opaque — a public 404 must not confirm which node ids exist.
    return c.html(unavailablePage(), 404);
  }
  // A null version means readArtifact found no approved snapshot and fell back
  // to the live body. Serving that would put an unapproved draft on the open
  // web, so a document that has never been approved simply has nothing to show.
  if (artifact.version == null) return c.html(unavailablePage(), 404);
  const type = String(artifact.type ?? "document");
  const body = artifact.html ?? "";
  const isHtml = isHtmlBody(type, body);

  await publish.logView(row.id, viewerEmail);
  applyArtifactSandboxHeaders(c);
  const overlays = overlayMarkup(row, viewerEmail);
  // A §1.12 view: its own approved intro and one neutral placeholder per
  // block. /p has no nest-user viewer, so it never resolves another node,
  // never frames an artifact and never carries nest-data.
  if (type === "view") {
    // Title and block count from the APPROVED version, like the body: the
    // live title may be an unapproved rename.
    let blockCount = 0;
    let title = row.node_id;
    try {
      const approved = await readViewVersion(row.nest_id, row.node_id, artifact.version);
      blockCount = approved.meta?.blocks.length ?? 0;
      title = approved.title || row.node_id;
    } catch {
      blockCount = 0;
    }
    const page = renderPublicViewPage({ title, intro: body, blockCount });
    return c.body(withOverlays(page, overlays), 200, {
      "Content-Type": "text/html; charset=utf-8",
    });
  }
  if (isHtml) {
    return c.body(withOverlays(body, overlays), 200, {
      "Content-Type": "text/html; charset=utf-8",
    });
  }
  const title = esc(artifact.title || row.node_id);
  // The body almost always opens with its own H1, so only fall back to the
  // node title when it doesn't — otherwise the page shows the heading twice.
  const heading = /^\s*#\s/.test(body) ? "" : `<h1>${title}</h1>`;
  // Branding wraps only this markdown shell. An HTML/artifact body above is
  // the author's own complete page and is served untouched.
  const brand = await loadBrand(row);
  const docTitle = brand?.b.site_title ? `${title} · ${esc(brand.b.site_title)}` : title;
  const brandCss = brand
    ? `body{background:var(--cn-page-bg,#fff)}h1,h2,h3,h4,a{color:var(--cn-accent-text,#142a80)}`
    : "";
  const shell = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${docTitle}</title><style>${PROSE_CSS}</style>${brandHead(brand, brandCss)}</head><body>${brandBar(brand)}${brandHero(brand)}<main>${heading}${markdown.render(body)}</main>${brandFooter(brand)}${overlays}</body></html>`;
  return c.body(shell, 200, { "Content-Type": "text/html; charset=utf-8" });
}

// Show/hide icons for the passcode field, inline so the gate page still loads
// nothing external (its `default-src` is wide open, but a gate that depends on
// a CDN is a gate that breaks offline).
const EYE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3.14M6.6 6.6A17.7 17.7 0 0 0 2 11s3.6 7 10 7a9 9 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m2 2 20 20"/></svg>`;

/** Reveal toggle for the passcode field. Keeps the caret where it was, so
 *  toggling mid-entry doesn't cost the reader their place. */
const GATE_EYE_SCRIPT = `<script>
  (function () {
    var input = document.getElementById("cn-code");
    var btn = document.getElementById("cn-eye");
    btn.addEventListener("click", function () {
      var show = input.type === "password";
      var at = input.selectionStart;
      input.type = show ? "text" : "password";
      btn.innerHTML = show ? ${JSON.stringify(EYE_OFF_SVG)} : ${JSON.stringify(EYE_SVG)};
      btn.setAttribute("aria-label", show ? "Hide code" : "Show code");
      btn.setAttribute("aria-pressed", show ? "true" : "false");
      input.focus();
      try { input.setSelectionRange(at, at); } catch (e) {}
    });
  })();
</script>`;

// Gate-page branding: accent on the heading and the submit button (with its
// auto-contrast text color), the page tint behind the card, the logo + site
// title above the heading, the footer line below.
const GATE_BRAND_CSS = `
    body{background:var(--cn-page-bg,#f4f4f5)}
    .card{box-sizing:border-box;overflow:hidden}
    h1{color:var(--cn-accent-text,#142a80)}
    button[type=submit]{background:var(--cn-accent,#142a80);color:var(--cn-accent-fg,#fff)}
    .cn-brand{margin:-32px -34px 20px;border-radius:14px 14px 0 0;padding:14px 20px}
    .cn-gate-foot{font-size:12px;color:#a8a29e;margin:10px 0 0;text-align:center}
    .cn-gate-foot a{color:var(--cn-accent-text,#142a80)}
`;

function gateBrandTop(brand: PublishBrand | null): string {
  return brandBar(brand);
}

function gateBrandFoot(brand: PublishBrand | null): string {
  if (!brand) return "";
  const { footer_text: text, footer_link_url: href, footer_link_label: label } = brand.b;
  const parts: string[] = [];
  if (text) parts.push(esc(text));
  if (href) parts.push(`<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${esc(label || href)}</a>`);
  return parts.length ? `<p class="cn-gate-foot">${parts.join(" · ")}</p>` : "";
}

/** The gate form (ordinary HTML — NOT sandboxed, so its form can post). */
function gatePage(row: PublishRow, message?: string, brand: PublishBrand | null = null): string {
  const wantsCode = row.access_mode === "code";
  // A passcode is typed from a slide, a QR, or someone reading it aloud, so
  // let the reader check what they typed before submitting.
  const field = wantsCode
    ? `<label>Access code<span class="wrap">
        <input id="cn-code" name="code" type="password" autocomplete="off" required autofocus>
        <button type="button" id="cn-eye" class="eye" aria-label="Show code" aria-pressed="false">${EYE_SVG}</button>
      </span></label>`
    : `<label>Your email<input name="email" type="email" autocomplete="email" required autofocus></label>`;
  const cta = wantsCode ? "Unlock" : "Send me a link";
  const note = wantsCode
    ? "This document is protected by a passcode."
    : "Enter your email and we'll send you a one-time link to open it.";
  const err = message
    ? `<p class="err">${esc(message)}</p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Protected document</title><style>
    :root{--indigo:#142a80;--owl:#FF6500}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;color:#1c1917;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
    .card{background:#fff;border:1px solid #e7e5e4;border-radius:14px;box-shadow:0 4px 24px rgba(20,42,128,.08);padding:32px 34px;max-width:380px;width:calc(100% - 32px)}
    h1{font-size:20px;color:var(--indigo);margin:0 0 6px}
    p{color:#78716c;margin:0 0 18px;font-size:14px}
    label{display:block;font-size:13px;font-weight:600;color:#44403c;margin-bottom:16px}
    input{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid #d6d3d1;border-radius:9px;font:inherit;box-sizing:border-box}
    .wrap{display:block;position:relative}
    .wrap input{padding-right:44px}
    button{width:100%;background:var(--indigo);color:#fff;font-weight:700;border:0;border-radius:9px;padding:11px;font-size:15px;cursor:pointer}
    button.eye{position:absolute;top:6px;right:0;width:40px;height:calc(100% - 6px);background:none;border:0;padding:0;color:#78716c;display:grid;place-items:center;cursor:pointer}
    button.eye:hover{color:#44403c}
    button.eye svg{width:18px;height:18px;display:block}
    .err{color:#be123c;font-weight:600}
    .brand{font-size:12px;color:#a8a29e;margin:18px 0 0;text-align:center}
  </style>${brandHead(brand, GATE_BRAND_CSS)}</head><body><form class="card" method="POST" action="/p/${esc(row.slug)}/gate">
    ${gateBrandTop(brand)}<h1>Protected document</h1><p>${esc(note)}</p>${err}${field}
    <button type="submit">${cta}</button>
    ${brand?.b.hide_powered_by ? "" : `<p class="brand">Secured by PromptOwl · ContextNest</p>`}${gateBrandFoot(brand)}
  </form>${wantsCode ? GATE_EYE_SCRIPT : ""}</body></html>`;
}

/** What a reader sees when a link no longer works — revoked, expired, or never
 *  real. Deliberately ONE message for all three: saying "revoked" rather than
 *  "expired" (or "no such link") would confirm which slugs exist. A person
 *  holding a dead link needs to know to ask for a new one, not which of the
 *  three it was. */
function unavailablePage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Link unavailable</title><style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;color:#1c1917;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
    .card{background:#fff;border:1px solid #e7e5e4;border-radius:14px;box-shadow:0 4px 24px rgba(20,42,128,.08);padding:32px 34px;max-width:420px;width:calc(100% - 32px);text-align:center}
    h1{font-size:20px;color:#142a80;margin:0 0 8px}
    p{color:#78716c;margin:0;font-size:14px}
    .brand{font-size:12px;color:#a8a29e;margin:18px 0 0}
  </style></head><body><div class="card">
    <h1>This link is no longer available</h1>
    <p>It may have been revoked by its owner, or it may have expired. Ask whoever shared it with you for a new link.</p>
    <p class="brand">Secured by PromptOwl · ContextNest</p>
  </div></body></html>`;
}

function sentPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Check your email</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f4f5;color:#1c1917;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}.card{background:#fff;border:1px solid #e7e5e4;border-radius:14px;box-shadow:0 4px 24px rgba(20,42,128,.08);padding:32px 34px;max-width:380px;text-align:center}h1{font-size:20px;color:#142a80;margin:0 0 6px}p{color:#78716c;margin:0;font-size:14px}</style></head><body><div class="card"><h1>Check your email</h1><p>If your address has access, a one-time link to open this document is on its way.</p></div></body></html>`;
}

/** The reader shell for a commentable publish: the document itself in a
 *  full-bleed same-origin iframe, with our comment button and modal alongside
 *  it.
 *
 *  The controls cannot live inside the document. That document is served under
 *  the artifact sandbox (opaque origin, `form-action 'none'`, `connect-src
 *  'none'`), and a popup opened from it inherits those sandbox flags — which is
 *  why the old separate comment page rendered but could never submit. Framing
 *  the document keeps its sandbox intact and puts the comment UI on a page we
 *  control and trust. */
function readerShell(
  row: PublishRow,
  title: string,
  viewerEmail: string | null,
  brand: PublishBrand | null = null,
): string {
  // A gated viewer is already identified; anyone else names themselves.
  const emailField = viewerEmail
    ? `<p class="who">Commenting as <strong>${esc(viewerEmail)}</strong></p>`
    : `<label>Your email<input id="cn-email" type="email" autocomplete="email" required></label>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>
    html,body{margin:0;height:100%}
    #cn-frame{border:0;width:100%;height:100%;display:block}
    #cn-open{position:fixed;right:18px;bottom:18px;z-index:20;background:#142a80;color:#fff;font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:11px 16px;border:0;border-radius:9999px;cursor:pointer;box-shadow:0 4px 14px rgba(20,42,128,.32)}
    #cn-back{position:fixed;inset:0;z-index:30;background:rgba(28,25,23,.45);display:none;place-items:center}
    #cn-back[data-open]{display:grid}
    .card{background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(20,42,128,.22);padding:28px 30px;width:min(460px,calc(100% - 32px));font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1c1917;box-sizing:border-box}
    .card h2{font-size:20px;color:#142a80;margin:0 0 6px}
    .card p{color:#78716c;margin:0 0 18px;font-size:14px}
    .who strong{color:#44403c}
    label{display:block;font-size:13px;font-weight:600;color:#44403c;margin-bottom:16px}
    input,textarea{display:block;width:100%;margin-top:6px;padding:10px 12px;border:1px solid #d6d3d1;border-radius:9px;font:inherit;box-sizing:border-box}
    textarea{min-height:130px;resize:vertical}
    .row{display:flex;gap:10px}
    button{flex:1;background:#142a80;color:#fff;font-weight:700;border:0;border-radius:9px;padding:11px;font-size:15px;cursor:pointer}
    button.ghost{background:#f5f5f4;color:#44403c}
    button[disabled]{opacity:.6;cursor:default}
    .msg{font-weight:600;margin:0 0 14px;font-size:14px}
    .msg.err{color:#be123c}.msg.ok{color:#15803d}
  </style>${brand ? `<style>${publishBrandCssVars(brand.b)}#cn-open,#cn-send{background:var(--cn-accent,#142a80);color:var(--cn-accent-fg,#fff)}.card h2{color:var(--cn-accent-text,#142a80)}</style>` : ""}</head><body>
    <iframe id="cn-frame" src="/p/${esc(row.slug)}/view" title="${esc(title)}"></iframe>
    <button id="cn-open" type="button">Leave a comment</button>
    <div id="cn-back"><div class="card" role="dialog" aria-modal="true" aria-label="Leave a comment">
      <h2>Leave a comment</h2>
      <p>Your comment goes to this document's stewards for review — it is not posted publicly.</p>
      <p class="msg" id="cn-msg" hidden></p>
      ${emailField}
      <label>Comment<textarea id="cn-body" maxlength="${COMMENT_MAX_CHARS}" required></textarea></label>
      <div class="row">
        <button type="button" class="ghost" id="cn-cancel">Cancel</button>
        <button type="button" id="cn-send">Send comment</button>
      </div>
    </div></div>
  <script>
  (function () {
    var back = document.getElementById("cn-back");
    var msg = document.getElementById("cn-msg");
    var send = document.getElementById("cn-send");
    var bodyEl = document.getElementById("cn-body");
    var emailEl = document.getElementById("cn-email");
    function show(text, ok) {
      msg.textContent = text;
      msg.className = "msg " + (ok ? "ok" : "err");
      msg.hidden = false;
    }
    function open() { msg.hidden = true; back.setAttribute("data-open", ""); (emailEl || bodyEl).focus(); }
    function close() { back.removeAttribute("data-open"); }
    document.getElementById("cn-open").addEventListener("click", open);
    document.getElementById("cn-cancel").addEventListener("click", close);
    back.addEventListener("click", function (e) { if (e.target === back) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    send.addEventListener("click", function () {
      var payload = { body: bodyEl.value };
      if (emailEl) payload.email = emailEl.value;
      send.disabled = true;
      fetch("/p/${esc(row.slug)}/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { show(res.d.error || "Could not send that comment.", false); return; }
          bodyEl.value = "";
          show("Thanks — your comment is with the stewards.", true);
          setTimeout(close, 1600);
        })
        .catch(function () { show("Could not reach the server.", false); })
        .then(function () { send.disabled = false; });
    });
  })();
  </script>${row.no_download === 1 ? SHELL_PRINT_BLANK : ""}</body></html>`;
}

/** CSP for the reader shell. The shell is our own markup, so it is NOT
 *  sandboxed — but it still may not load anything external, and it may only
 *  frame and talk to this origin. The framed document keeps its own strict
 *  artifact sandbox. */
const SHELL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "frame-src 'self'",
  "connect-src 'self'",
].join("; ");

/** Who is allowed to see this publish right now, and who they are. `null` means
 *  the gate has not been passed. A public viewer is allowed but anonymous. */
async function resolveViewer(
  c: any,
  row: PublishRow,
): Promise<{ email: string | null } | null> {
  if (row.access_mode === "public") return { email: null };
  // A live session carries the viewer it was opened for, so an email/invite view
  // is logged against the person who opened it rather than as an anonymous hit.
  const token = readCookie(c, cookieName(row.slug));
  return token ? await publish.verifySession(row.id, token) : null;
}

// GET /p/:slug — the document, or the gate, or (when comments are on) the
// reader shell that frames the document alongside the comment controls.
publishRenderRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row)) return c.html(unavailablePage(), 404);

  const viewer = await resolveViewer(c, row);
  if (!viewer) return c.html(gatePage(row, undefined, await loadBrand(row)));
  if (row.comments_enabled !== 1) return renderPublished(c, row, viewer.email);

  // The shell frames /view, which is what logs the view and applies the
  // sandbox — nothing is logged twice.
  const title = await publishedTitle(row);
  c.header("Content-Security-Policy", SHELL_CSP);
  c.header("Referrer-Policy", "no-referrer");
  return c.html(readerShell(row, title, viewer.email, await loadBrand(row)));
});

// GET /p/:slug/view — the document itself, always sandboxed. Framed by the
// shell above, and gated independently: being the frame source is not
// authorization.
publishRenderRoutes.get("/:slug/view", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row)) return c.html(unavailablePage(), 404);
  const viewer = await resolveViewer(c, row);
  if (!viewer) return c.html(unavailablePage(), 404);
  return renderPublished(c, row, viewer.email);
});

// POST /p/:slug/comments — file a comment against the document.
publishRenderRoutes.post("/:slug/comments", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row) || row.comments_enabled !== 1) {
    return c.json({ error: "Not found" }, 404);
  }
  // Posting requires clearing the document's own gate, so an unauthenticated
  // writer can never appear on a gated document.
  const viewer = await resolveViewer(c, row);
  if (!viewer) return c.json({ error: "Not found" }, 404);

  if (!tryConsume(`publish-comment:${slug}:${clientIp(c)}`, COMMENT_LIMIT)) {
    return c.json({ error: "Too many comments. Try again in a few minutes." }, 429);
  }

  const input = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    body?: string;
  };
  // The ticket requires an identifying email on every comment: take the gated
  // viewer's when we have one, otherwise the address they typed.
  const email = viewer.email ?? normalizeEmail(String(input.email ?? ""));
  if (!isEmailish(email)) {
    return c.json({ error: "Enter a valid email address." }, 400);
  }
  const body = String(input.body ?? "").trim().slice(0, COMMENT_MAX_CHARS);
  if (!body) {
    return c.json({ error: "Write a comment first." }, 400);
  }

  // Lands as an unanchored annotation thread — the same list the document's
  // Comments panel already renders, so a steward actually sees it. A public
  // reader can never open-write onto the document itself.
  await createThread(row.nest_id, row.node_id, { body, anchor: null }, email);
  return c.json({ ok: true });
});

// POST /p/:slug/gate — submit code (unlock now) or email (send magic link).
publishRenderRoutes.post("/:slug/gate", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row)) return c.html(unavailablePage(), 404);

  // Anonymous endpoint: without a clamp, the code gate is an unlimited guessing
  // oracle against a human-chosen passcode, and the email branch is an open
  // relay that mails any address an attacker supplies.
  if (!tryConsume(`publish-gate:${slug}:${clientIp(c)}`, GATE_LIMIT)) {
    return c.html(gatePage(row, "Too many attempts. Try again in a few minutes.", await loadBrand(row)), 429);
  }

  // A public link has no gate to pass, so a POST here is either a stale form or
  // someone probing for the email branch below. Never fall through to it.
  if (row.access_mode === "public") return c.redirect(`/p/${slug}`);

  const form = await c.req.parseBody();

  if (row.access_mode === "code") {
    if (!(await publish.verifyCode(row, String(form.code ?? "")))) {
      return c.html(gatePage(row, "That code is not correct.", await loadBrand(row)), 401);
    }
    setSessionCookie(c, slug, await publish.createSession(row.id, null));
    return c.redirect(`/p/${slug}`);
  }

  const email = normalizeEmail(String(form.email ?? ""));
  if (!isEmailish(email)) {
    return c.html(gatePage(row, "Enter a valid email address.", await loadBrand(row)), 400);
  }
  // Invite mode: only allow-listed addresses get a link. Both branches must
  // cost the same, not just look the same — returning early on a rejection
  // would skip the mint's INSERT and leave a latency difference that answers
  // "is this address invited?" just as well as a different page would. So the
  // token is always minted; the allow-list decides only whether it is sent.
  // The undelivered token is inert: single-use, expiring, and known to nobody.
  const allowed =
    row.access_mode !== "invite" || (await publish.isAllowlisted(row.id, email));
  const linkToken = await publish.mintMagicLink(row.id, email);
  if (!allowed) return c.html(sentPage());
  const link = `${requestBaseUrl(c.req.url)}/p/${slug}/verify?token=${linkToken}`;
  void sendEmailToRecipient(email, {
    status: "shared",
    docTitle: "A document has been shared with you",
    path: "PromptOwl · ContextNest",
    link,
  }, { nestId: row.nest_id });
  return c.html(sentPage());
});

// GET /p/:slug/verify?token= — consume the magic link, open a session, redirect.
publishRenderRoutes.get("/:slug/verify", async (c) => {
  const slug = c.req.param("slug");
  const row = await publish.getPublishBySlug(slug);
  if (!publish.isLivePublish(row)) return c.html(unavailablePage(), 404);
  const email = await publish.consumeMagicLink(row.id, c.req.query("token") ?? "");
  if (!email) {
    return c.html(gatePage(row, "That link is invalid or has expired. Request a new one.", await loadBrand(row)), 401);
  }
  setSessionCookie(c, slug, await publish.createSession(row.id, email));
  return c.redirect(`/p/${slug}`);
});
