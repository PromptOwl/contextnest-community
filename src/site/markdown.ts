/**
 * Markdown → HTML for the public docs site (CU-wdqcq05jhm).
 *
 * `html: false` keeps any raw HTML in a body escaped: the site is plain static
 * HTML on the open web with no sandbox around it, so a node body must never
 * become executable markup. `[[target|label]]` wikilinks become ordinary
 * anchors (crawlers follow `<a href>`, not app clicks); a target that is not
 * on the site — a draft, a typo — renders as its label, never a dead link.
 * Headings get stable ids so the outline and `#fragment` links work.
 */
import MarkdownIt from "markdown-it";

export interface Heading {
  level: number;
  id: string;
  text: string;
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

export function renderMarkdown(
  body: string,
  resolveLink: (target: string) => string | null,
): { html: string; headings: Heading[] } {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
    const end = src.indexOf("]]", start + 2);
    if (end < 0) return false;
    const inner = src.slice(start + 2, end);
    if (!inner.trim() || inner.includes("\n")) return false;
    if (!silent) {
      const [rawTarget, ...rest] = inner.split("|");
      const [path, fragment] = rawTarget.split("#");
      const label = rest.join("|").trim() || fragment?.trim() || path.trim().split("/").pop() || path.trim();
      const href = resolveLink(path.trim());
      if (href) {
        const open = state.push("link_open", "a", 1);
        open.attrs = [["href", fragment ? `${href}#${slugifyHeading(fragment)}` : href]];
        state.push("text", "", 0).content = label;
        state.push("link_close", "a", -1);
      } else {
        state.push("text", "", 0).content = label;
      }
    }
    state.pos = end + 2;
    return true;
  });

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

  // Outbound links leave the site without passing the referrer's ranking on
  // to whatever a node body happens to link.
  const defaultLinkOpen =
    md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet("href") ?? "";
    if (/^https?:\/\//i.test(href)) tokens[idx].attrSet("rel", "noopener");
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  const html = md.render(body);
  return { html, headings };
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

/** A ~155-character description that ends on a word, never mid-word. */
export function describe(body: string, max = 155): string {
  const text = plainText(body);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 80 ? lastSpace : max).replace(/[,;:.\s]+$/, "")}…`;
}
