/**
 * DocumentViewer — read-only markdown renderer.
 *
 * The product invariant per CU-86ahmvmex: nodes are immutable markdown.
 * Editing is a separate, explicit action. This component renders the
 * source markdown to formatted HTML for *reading*; it does NOT serialize
 * back to a different format. The string you pass in is byte-for-byte
 * what's on disk.
 *
 * WikiLinks: `[[Title]]` and `[[Title|Display]]` are turned into
 * clickable elements via a small remark plugin. Click handling is the
 * caller's job — pass `onWikiLinkClick(title)` and route navigation
 * however you want.
 *
 * GFM: tables, task lists, strikethrough, footnotes, and autolinks come
 * from `remark-gfm`.
 *
 * Mentions: `@user@example.com` and `@(Name With Spaces)` render as an
 * `@name` chip via `remarkMentions`, instead of the raw address `remark-gfm`
 * would otherwise autolink.
 *
 * Math: `$…$` / `$$…$$` parse via `remark-math` and typeset with KaTeX.
 * Invalid TeX renders in red instead of throwing.
 *
 * Text color: the editor's color swatches persist as a raw
 * `<span style="color: …">` (valid CommonMark inline HTML — see
 * MarkdownEditor's TextStyle/Color import comment). `remarkColorSpans`
 * below recognizes that exact shape and renders it as a real colored span;
 * any other raw HTML is stripped to plain text by `remarkStripHtml`.
 */
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { remarkMathNoCurrency } from "@/lib/markdown-math";
import { remarkMentions } from "@/lib/markdown-mentions";
import type { Plugin } from "unified";
import type { Root, Text } from "mdast";
import { visit } from "unist-util-visit";
import { cn } from "@/lib/utils";

const wikiLinkRegex = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

// `[[Title]]` / `[[Title|Display]]` → synthetic `wikilink` hast element.
// Custom hName sidesteps react-markdown's urlTransform allowlist (no `wiki:` scheme to sanitize).
const remarkWikiLinks: Plugin<[], Root> = () => (tree) => {
  visit(tree, "text", (node: Text, index, parent) => {
    if (!parent || index === null || index === undefined) return;
    const text = node.value;
    wikiLinkRegex.lastIndex = 0;
    if (!wikiLinkRegex.test(text)) return;

    wikiLinkRegex.lastIndex = 0;
    const newChildren: any[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = wikiLinkRegex.exec(text)) !== null) {
      if (m.index > lastIndex) {
        newChildren.push({ type: "text", value: text.slice(lastIndex, m.index) });
      }
      const target = m[1].trim();
      const display = (m[2] ?? m[1]).trim();
      newChildren.push({
        type: "wikiLink",
        data: {
          hName: "wikilink",
          hProperties: {
            "data-wiki-target": target,
            "data-wiki-display": display,
          },
          // «Title» is Hootie's wiki-link convention — the guillemets read as
          // "this points at another document" without relying on link colour
          // alone. The target and the hover preview use the bare title.
          hChildren: [{ type: "text", value: `«${display}»` }],
        },
      });
      lastIndex = wikiLinkRegex.lastIndex;
    }
    if (lastIndex < text.length) {
      newChildren.push({ type: "text", value: text.slice(lastIndex) });
    }
    parent.children.splice(index, 1, ...newChildren);
    return index + newChildren.length;
  });
};

// `<span style="color: #rrggbb">…</span>` — the one raw-HTML shape the
// editor itself writes (its text-color swatches). remark tokenizes raw HTML
// as plain sibling `html` nodes rather than a single element, so this scans
// each container's children for that exact open/close pair and swaps the
// run for a real hast `span` carrying the color style. Only a plain-text
// run in between is handled (the common case for this feature); anything
// else in between is left alone and falls through to remarkStripHtml below.
const COLOR_SPAN_OPEN =
  /^<span style=["']color:\s*(#[0-9a-fA-F]{3,8})["']>$/;
const COLOR_SPAN_CLOSE = /^<\/span>$/;

const remarkColorSpans: Plugin<[], Root> = () => (tree) => {
  visit(tree, "html", (node: any, index, parent) => {
    if (!parent || index === null || index === undefined) return;
    const m = COLOR_SPAN_OPEN.exec((node.value ?? "").trim());
    if (!m) return;

    const siblings = parent.children as any[];
    let closeIndex = -1;
    for (let j = index + 1; j < siblings.length; j++) {
      const candidate = siblings[j];
      if (candidate.type !== "html") continue;
      const text = (candidate.value ?? "").trim();
      // Editor never nests color spans — bail on another open tag rather
      // than risk pairing with the wrong close tag.
      if (COLOR_SPAN_OPEN.test(text)) break;
      if (COLOR_SPAN_CLOSE.test(text)) {
        closeIndex = j;
      }
      break;
    }
    if (closeIndex === -1) return;

    const inner = siblings.slice(index + 1, closeIndex);
    if (!inner.every((n) => n.type === "text")) return;
    const value = inner.map((n) => n.value).join("");

    siblings.splice(index, closeIndex - index + 1, {
      type: "colorSpan",
      data: {
        hName: "span",
        hProperties: { style: `color: ${m[1]}` },
        hChildren: [{ type: "text", value }],
      },
    });
    return index;
  });
};

// Stored docs are markdown-only, but legacy content can carry stray inline
// HTML (e.g. an unmatched color <span> from an old save, or hand-authored
// HTML). react-markdown renders raw HTML as literal text — turn html nodes
// into plain text with tags stripped so only the inner text shows. Fenced
// code is a `code` node, never `html`, so code samples are untouched.
const remarkStripHtml: Plugin<[], Root> = () => (tree) => {
  visit(tree, "html", (node: any) => {
    node.type = "text";
    // Loop until stable: a single pass of /<[^>]*>/g can leave behind
    // fragments that reassemble into another tag (e.g. `<scr<script>ipt>`).
    let value = node.value || "";
    let prev: string;
    do {
      prev = value;
      value = value.replace(/<[^>]*>/g, "");
    } while (value !== prev);
    node.value = value;
  });
};

// Same-origin nest video assets only: a root-relative /nests/<id>/assets/
// path with a server-minted uuid name (mirrors SAFE_NAME in
// src/nests/asset-routes.ts). External URLs never match — they stay plain
// links, no exceptions.
const ASSET_VIDEO_RE =
  /^\/nests\/[^/]+\/assets\/[0-9a-f-]{36}\.(mp4|webm)$/;

// stopPropagation: block parent click-to-edit when using the controls.
const AssetVideo = ({ src }: { src: string }) => (
  <video
    controls
    preload="metadata"
    className="max-w-full"
    src={src}
    onClick={(e) => e.stopPropagation()}
  />
);

export interface DocumentViewerProps {
  /** The raw markdown source to render. Should NOT be HTML; use a
   *  read-only TipTap surface for HTML-stored legacy docs. */
  content: string;
  /** Called when the user clicks a `[[WikiLink]]`. Receives the title
   *  (post-trim), not the optional display alias. */
  onWikiLinkClick?: (title: string) => void;
  /** Hover-preview lookup for a wiki-link target; return null for no
   *  preview (unknown target). Synchronous — caller caches the list. */
  previewFor?: (target: string) => { title: string; snippet: string } | null;
  className?: string;
}

export function DocumentViewer({
  content,
  onWikiLinkClick,
  previewFor,
  className,
}: DocumentViewerProps) {
  // One hover-preview at a time; opens after a short debounce so quick
  // mouse passes don't flash popovers. Fixed-positioned at the cursor.
  const [preview, setPreview] = useState<{
    title: string;
    snippet: string;
    x: number;
    y: number;
  } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showPreview = (target: string, x: number, y: number) => {
    if (!previewFor) return;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      const p = previewFor(target);
      if (p) setPreview({ ...p, x, y });
    }, 250);
  };
  const hidePreview = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setPreview(null);
  };
  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);
  // Sequential ids on rendered h1–h3, in document order, matching
  // lib/toc.extractHeadings — the outline's i-th entry targets `doc-h-<i>`.
  // Reset per render; react-markdown emits one tree per pass.
  let headingIndex = 0;
  const heading =
    (Tag: "h1" | "h2" | "h3") =>
    ({ children, ...props }: any) => (
      <Tag id={`doc-h-${headingIndex++}`} {...props}>
        {children}
      </Tag>
    );
  return (
    <div
      className={cn(
        // Match editor's prose + fixed height/scroll for parity.
        "prose prose-sm dark:prose-invert max-w-none px-6 py-4",
        "min-h-[60vh] max-h-[60vh] overflow-y-auto",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm,
          remarkMentions,
          remarkMath,
          remarkMathNoCurrency,
          remarkColorSpans,
          remarkStripHtml,
          remarkWikiLinks,
        ]}
        rehypePlugins={[rehypeKatex]}
        // Cast: Components type keyed on HTML names; `wikilink` not in union.
        components={
          {
            h1: heading("h1"),
            h2: heading("h2"),
            h3: heading("h3"),
            // `@user` mention chip — see remarkMentions above. Plain span,
            // not a link: nothing to navigate to in the read-only viewer,
            // and the full email stays out of the visible text.
            mention: ({ children }: any) => (
              <span className="mention mention-user">{children}</span>
            ),
            wikilink: ({ children, ...props }: any) => {
              const target = (props["data-wiki-target"] ?? "") as string;
              return (
                <button
                  type="button"
                  className="wiki-link wiki-link-exists bg-transparent border-0 p-0 m-0 cursor-pointer"
                  title={previewFor ? undefined : `Open "${target}"`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    hidePreview();
                    onWikiLinkClick?.(target);
                  }}
                  onMouseEnter={(e) =>
                    showPreview(target, e.clientX, e.clientY)
                  }
                  onMouseLeave={hidePreview}
                >
                  {children}
                </button>
              );
            },
            // The editor inserts uploaded videos as the bare asset URL on
            // its own line — a paragraph whose sole text child is a
            // same-origin asset video URL renders as the player.
            p: ({ node, children, ...props }: any) => {
              const kids = node?.children;
              if (
                kids?.length === 1 &&
                kids[0].type === "text" &&
                ASSET_VIDEO_RE.test(kids[0].value.trim())
              ) {
                return <AssetVideo src={kids[0].value.trim()} />;
              }
              return <p {...props}>{children}</p>;
            },
            // Image syntax pointing at a video asset also gets the player;
            // real images keep react-markdown's default <img> rendering.
            img: ({ src, ...props }: any) =>
              typeof src === "string" && ASSET_VIDEO_RE.test(src) ? (
                <AssetVideo src={src} />
              ) : (
                <img src={src} {...props} />
              ),
            // stopPropagation: block parent click-to-edit on link click.
            // Same-origin asset video links render as the player instead.
            a: ({ href, children, ...props }: any) =>
              typeof href === "string" && ASSET_VIDEO_RE.test(href) ? (
                <AssetVideo src={href} />
              ) : (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}
                  {...props}
                >
                  {children}
                </a>
              ),
          } as any
        }
      >
        {content}
      </ReactMarkdown>

      {preview && (
        <div
          className="fixed z-50 max-w-xs rounded-md border bg-popover text-popover-foreground shadow-md p-3 pointer-events-none"
          style={{
            left: Math.min(preview.x + 12, window.innerWidth - 320),
            top: preview.y + 16,
          }}
        >
          <div className="text-sm font-semibold mb-1">{preview.title}</div>
          <div className="text-xs text-muted-foreground leading-relaxed">
            {preview.snippet || "(empty document)"}
          </div>
        </div>
      )}
    </div>
  );
}
