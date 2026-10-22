/**
 * Markdown → HTML for the public docs site (CU-wdqcq05jhm).
 *
 * `html: false` keeps any raw HTML in a body escaped: the site is plain static
 * HTML on the open web with no sandbox around it, so a node body must never
 * become executable markup. Every way a body can point at another document —
 * `[[target|label]]`, `[label](contextnest://…)`, `[label](nodes/x)`,
 * `[label](x.md)` — becomes an ordinary anchor to that page's site URL
 * (crawlers follow `<a href>`, not app clicks); a target that isn't on the
 * site (a draft, a typo) renders as plain text, never a dead link. The pages
 * a body links to are reported back, so the site can build backlinks and
 * related pages from them. Glossary terms are linked at their first mention.
 */
import MarkdownIt from "markdown-it";
type Token = ReturnType<MarkdownIt["parse"]>[number];
import { contextLinkTarget } from "@promptowl/contextnest-engine";

export interface Heading {
  level: number;
  id: string;
  text: string;
}

export interface LinkTarget {
  href: string;
  nodeId: string;
}

export interface RenderOptions {
  /** Resolve a document reference (path, id, title or slug) to its page. */
  resolve: (target: string) => LinkTarget | null;
  /** Glossary terms to link at their first mention on the page. */
  terms?: Array<{ term: string; href: string }>;
}

/** "Configure the CLI" → "configure-the-cli". */
export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[`*_~]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

/** A link href that names a document rather than a web page, as a resolvable target. */
function documentTarget(href: string): string | null {
  if (/^contextnest:\/\//i.test(href)) {
    try {
      return contextLinkTarget(href);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) return null;
  const path = href.split("#")[0];
  if (/^\/?nodes\//.test(path) || /\.md$/i.test(path)) return path.replace(/^\.?\//, "");
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `target#fragment|label` inside `[[ ]]`, with the label the page shows. */
function wikiParts(inner: string): { path: string; fragment: string | undefined; label: string } {
  const [rawTarget, ...rest] = inner.split("|");
  const [path, fragment] = rawTarget.split("#");
  const label = rest.join("|").trim() || fragment?.trim() || path.trim().split("/").pop() || path.trim();
  return { path: path.trim(), fragment, label };
}

/**
 * The body as Markdown for the `.md` twin and llms-full.txt, with links
 * handled as in the HTML: a document link points at its page URL, and one to
 * anything not on the site (a draft, a typo) keeps only its label, so an
 * unpublished path never leaks. Code spans and fences are left as written.
 */
export function rewriteDocumentLinks(body: string, resolve: (target: string) => string | null): string {
  return body
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\[\[([^\]\n]+)\]\]/g, (_, inner: string) => {
              const { path, fragment, label } = wikiParts(inner);
              const url = resolve(path);
              return url ? `[${label}](${fragment ? `${url}#${slugifyHeading(fragment)}` : url})` : label;
            })
            .replace(/(!?)\[([^\]\n]*)\]\(([^)\s]+)(\s+"[^"\n]*")?\)/g, (m, bang: string, label: string, href: string) => {
              const target = bang ? null : documentTarget(href);
              if (target === null) return m;
              const url = resolve(target);
              const frag = href.includes("#") ? `#${href.split("#").pop()}` : "";
              return url ? `[${label}](${url}${frag})` : label;
            }),
    )
    .join("");
}

export function renderMarkdown(
  body: string,
  opts: RenderOptions,
): { html: string; headings: Heading[]; linked: Set<string> } {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  const linked = new Set<string>();

  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
    const end = src.indexOf("]]", start + 2);
    if (end < 0) return false;
    const inner = src.slice(start + 2, end);
    if (!inner.trim() || inner.includes("\n")) return false;
    if (!silent) {
      const { path, fragment, label } = wikiParts(inner);
      const hit = opts.resolve(path);
      if (hit) {
        linked.add(hit.nodeId);
        const open = state.push("link_open", "a", 1);
        open.attrs = [["href", fragment ? `${hit.href}#${slugifyHeading(fragment)}` : hit.href]];
        state.push("text", "", 0).content = label;
        state.push("link_close", "a", -1);
      } else {
        state.push("text", "", 0).content = label;
      }
    }
    state.pos = end + 2;
    return true;
  });

  // Markdown links that name documents → site URLs; unknown ones → plain text.
  md.core.ruler.push("document_links", (state) => {
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      const out: Token[] = [];
      let dropClose = 0;
      for (const t of block.children) {
        if (t.type === "link_open") {
          const href = t.attrGet("href") ?? "";
          const target = documentTarget(href);
          if (target !== null) {
            const hit = opts.resolve(target);
            if (!hit) {
              dropClose++;
              continue;
            }
            linked.add(hit.nodeId);
            const frag = href.includes("#") ? `#${href.split("#").pop()}` : "";
            t.attrSet("href", `${hit.href}${frag}`);
          }
        }
        if (t.type === "link_close" && dropClose > 0) {
          dropClose--;
          continue;
        }
        out.push(t);
      }
      block.children = out;
    }
  });

  // Glossary: link each term's first mention, outside links, code and headings.
  const terms = (opts.terms ?? []).filter((t) => t.term.trim().length >= 3);
  if (terms.length) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])(${terms
        .map((t) => escapeRe(t.term.trim()))
        .sort((a, b) => b.length - a.length)
        .join("|")})(?![\\p{L}\\p{N}])`,
      "iu",
    );
    const hrefOf = new Map(terms.map((t) => [t.term.trim().toLowerCase(), t.href]));
    md.core.ruler.push("glossary_terms", (state) => {
      const used = new Set<string>();
      let inHeading = false;
      for (const block of state.tokens) {
        if (block.type === "heading_open") inHeading = true;
        if (block.type === "heading_close") inHeading = false;
        if (block.type !== "inline" || !block.children || inHeading) continue;
        const out: Token[] = [];
        let depth = 0;
        for (const t of block.children) {
          if (t.type === "link_open") depth++;
          if (t.type === "link_close") depth--;
          if (t.type !== "text" || depth > 0) {
            out.push(t);
            continue;
          }
          let rest = t.content;
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(rest))) {
            const key = m[1].toLowerCase();
            if (used.has(key)) {
              // Seen already: emit through this match and keep scanning after it.
              const head = new state.Token("text", "", 0);
              head.content = rest.slice(0, m.index + m[0].length);
              out.push(head);
              rest = rest.slice(m.index + m[0].length);
              continue;
            }
            used.add(key);
            const before = new state.Token("text", "", 0);
            before.content = rest.slice(0, m.index);
            const open = new state.Token("link_open", "a", 1);
            open.attrs = [["href", hrefOf.get(key)!], ["class", "term"]];
            const text = new state.Token("text", "", 0);
            text.content = m[1];
            const close = new state.Token("link_close", "a", -1);
            out.push(before, open, text, close);
            rest = rest.slice(m.index + m[0].length);
          }
          const tail = new state.Token("text", "", 0);
          tail.content = rest;
          out.push(tail);
        }
        block.children = out;
      }
    });
  }

  const headings: Heading[] = [];
  const seen = new Map<string, number>();
  md.core.ruler.push("heading_ids", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      // The page template owns the one <h1>; a body H1 reads as a section.
      if ((tokens[i].type === "heading_open" || tokens[i].type === "heading_close") && tokens[i].tag === "h1") {
        tokens[i].tag = "h2";
      }
      if (tokens[i].type !== "heading_open") continue;
      const text = tokens[i + 1]?.children?.map((t) => t.content).join("") ?? "";
      const base = slugifyHeading(text);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const id = n ? `${base}-${n}` : base;
      tokens[i].attrSet("id", id);
      headings.push({ level: Number(tokens[i].tag.slice(1)), id, text });
    }
  });

  // Outbound links open nothing on our origin and pass no session along.
  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet("href") ?? "";
    if (/^https?:\/\//i.test(href)) tokens[idx].attrSet("rel", "noopener");
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  const html = md.render(body);
  return { html, headings, linked };
}

/** Plain text of a Markdown body, for meta descriptions and llms.txt. */
export function plainText(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s{0,3}#{1,6}\s.*$/gm, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_m, t: string) => t.split("/").pop() ?? t)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_>|#~]/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A ~155-character description that ends on a word, never mid-word. Taken
 * from the body's first prose paragraphs — the answer-first lead a docs page
 * should open with — not from headings, lists, tables or code, which read as
 * run-on fragments once flattened.
 */
export function describe(body: string, max = 155): string {
  const blocks = body.replace(/```[\s\S]*?```/g, "\n\n").split(/\n\s*\n/);
  const prose = blocks
    .map((b) => b.trim())
    .filter((b) => b && !/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>|<!--|---|\*\*\*)/.test(b));
  let lead = "";
  for (const p of prose) {
    lead = `${lead} ${plainText(p)}`.trim();
    if (lead.length >= 80) break;
  }
  const text = lead || plainText(body);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : max).replace(/[,;:.\s]+$/, "")}…`;
}
