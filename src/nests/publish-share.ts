/**
 * What a published page (/p/:slug) carries for the people it is shared with
 * (PO-1365): link-preview tags for whoever pastes the link, and one quiet way
 * in for whoever reads it — "Make your own nest".
 *
 * Pure markup helpers, no I/O. publish-render-routes.ts decides WHERE each
 * goes; the rules that matter live there:
 *   - the strip is only ever on our own page chrome, never in the bytes
 *     /p/:slug/view serves (the sandboxed document);
 *   - a white-label nest (hide_powered_by) gets no strip;
 *   - a gated page gets the gate's own title and no excerpt.
 */
import MarkdownIt from "markdown-it";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Where a reader of a shared page starts a nest of their own: this
 *  deployment's sign-in / sign-up entry (the app root, which shows it to a
 *  signed-out visitor). `ref=share` says where they came from. */
export function signUpUrl(baseUrl: string): string {
  return `${baseUrl}/?ref=share`;
}

// ── The strip ───────────────────────────────────────────────────────────────

const SANS = `-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`;

/** One look for both homes of the strip: the bottom of the reader shell, and
 *  the bottom of a markdown page (where it sticks to the viewport). Neutral on
 *  purpose — it sits under someone else's document and must not compete with
 *  it, so it takes no nest accent color. */
export const CTA_CSS = `
  .cn-cta{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:48px;padding:8px 20px;background:#fff;border-top:1px solid #e7e5e4;color:#57534e;font:13px/1.4 ${SANS}}
  .cn-cta-by{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cn-cta-by strong{color:#1c1917;font-weight:600}
  .cn-cta a{flex:none;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:1px solid #d6d3d1;border-radius:8px;background:#fff;color:#1c1917;font-weight:600;text-decoration:none;white-space:nowrap}
  .cn-cta a:hover{background:#fafaf9;border-color:#a8a29e}
  .cn-cta a:focus-visible{outline:2px solid #142a80;outline-offset:2px}
  .cn-cta svg{width:14px;height:14px;display:block}
  @media (max-width:560px){.cn-cta{padding:8px 16px}.cn-cta-more{display:none}}
  @media print{.cn-cta{display:none}}
`;

const ARROW_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>`;

/** The strip itself. `baseUrl` is this deployment's own origin. */
export function ctaStrip(baseUrl: string): string {
  return (
    `<aside class="cn-cta" data-cn-cta aria-label="About this page">` +
    `<span class="cn-cta-by"><strong>ContextNest</strong><span class="cn-cta-more"> · The shared, governed brain for a team and its agents</span></span>` +
    `<a href="${esc(signUpUrl(baseUrl))}">Make your own nest${ARROW_SVG}</a>` +
    `</aside>`
  );
}

/** The same invitation as one line under the gate card's "Secured by" line.
 *  It says nothing about the document behind the gate. */
export const GATE_CTA_CSS = `
    .cn-gate-cta{font-size:12px;margin:6px 0 0;text-align:center}
    .cn-gate-cta a{color:#78716c;font-weight:500;text-decoration:underline;text-underline-offset:2px}
    .cn-gate-cta a:hover{color:#1c1917}
`;

export function gateCta(baseUrl: string): string {
  return `<p class="cn-gate-cta" data-cn-cta><a href="${esc(signUpUrl(baseUrl))}">Make your own nest</a></p>`;
}

// ── Link previews ───────────────────────────────────────────────────────────

const EXCERPT_MAX = 200;
const md = new MarkdownIt({ html: false, linkify: false });

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Markup to plain text: what is not prose is dropped, then tags, then
 *  entities. The result is TEXT, and is escaped again wherever it is written. */
function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|head|title|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    // Dropping an inline tag leaves its space behind: "approved , then".
    .replace(/ ([.,;:!?])/g, "$1")
    .trim();
}

/**
 * A short plain-text excerpt of a published body, for a link preview.
 *
 * The caller passes the APPROVED body (readArtifact), never the working copy.
 * A leading heading that only repeats the title is dropped, so the preview
 * does not say the title twice.
 */
export function excerptOf(body: string, isHtml: boolean, title = ""): string {
  let text = textOf(isHtml ? body : md.render(body));
  const t = title.trim();
  // Only a whole leading title: "Deck" must not eat the start of "Decks are…".
  if (t && text.toLowerCase().startsWith(t.toLowerCase()) && !/^[\p{L}\p{N}]/u.test(text.slice(t.length))) {
    text = text.slice(t.length).trim();
  }
  if (text.length <= EXCERPT_MAX) return text;
  const cut = text.slice(0, EXCERPT_MAX);
  const at = cut.lastIndexOf(" ");
  return `${(at > EXCERPT_MAX * 0.6 ? cut.slice(0, at) : cut).replace(/[\s.,;:!?-]+$/, "")}…`;
}

export interface PreviewMeta {
  title: string;
  /** Omitted on a gated page, and whenever there is nothing safe to quote. */
  description?: string;
  url: string;
  siteName: string;
  image: string;
  /** `summary_large_image` for the default 1200x630 card, `summary` for a logo. */
  card: "summary" | "summary_large_image";
}

/**
 * Indexing. /p pages have never carried a robots directive, and robots.txt
 * does not disallow /p/, so a published page is indexable by whoever finds
 * its (unguessable) link. This tag states that behaviour rather than changing
 * it; making shared links `noindex` is a policy decision, made here in one
 * place if it is taken.
 */
export const PUBLISH_ROBOTS = "index, follow";

/** The `<head>` tags for a link preview. Every value is escaped here. */
export function previewMetaTags(m: PreviewMeta): string {
  const tags: Array<[string, string, string]> = [
    ["name", "robots", PUBLISH_ROBOTS],
    ["property", "og:type", "article"],
    ["property", "og:title", m.title],
    ["property", "og:url", m.url],
    ["property", "og:site_name", m.siteName],
    ["property", "og:image", m.image],
    ["name", "twitter:card", m.card],
    ["name", "twitter:title", m.title],
    ["name", "twitter:image", m.image],
  ];
  if (m.description) {
    tags.push(
      ["name", "description", m.description],
      ["property", "og:description", m.description],
      ["name", "twitter:description", m.description],
    );
  }
  return tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${esc(value)}">`).join("");
}

/** Put our tags in an existing page's `<head>`. A page with no `<head>` is
 *  left alone: writing one in front of it could change how it renders. A page
 *  that already has Open Graph tags keeps its author's. */
export function withHeadTags(html: string, tags: string): string {
  if (!tags) return html;
  const m = /<head\b[^>]*>/i.exec(html);
  if (!m) return html;
  const end = html.toLowerCase().indexOf("</head>", m.index);
  const head = end === -1 ? "" : html.slice(m.index, end);
  if (/property\s*=\s*["']og:/i.test(head)) return html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + tags + html.slice(at);
}
