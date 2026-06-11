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
 * GFM: tables, task lists, strikethrough, and autolinks come from
 * `remark-gfm`.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
          hChildren: [{ type: "text", value: display }],
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

// Stored docs are markdown-only, but legacy content can carry stray inline
// HTML (e.g. color <span>s from older saves). react-markdown renders raw
// HTML as literal text — turn html nodes into plain text with tags stripped
// so only the inner text shows. Fenced code is a `code` node, never `html`,
// so code samples are untouched.
const remarkStripHtml: Plugin<[], Root> = () => (tree) => {
  visit(tree, "html", (node: any) => {
    node.type = "text";
    node.value = (node.value || "").replace(/<[^>]*>/g, "");
  });
};

export interface DocumentViewerProps {
  /** The raw markdown source to render. Should NOT be HTML; use a
   *  read-only TipTap surface for HTML-stored legacy docs. */
  content: string;
  /** Called when the user clicks a `[[WikiLink]]`. Receives the title
   *  (post-trim), not the optional display alias. */
  onWikiLinkClick?: (title: string) => void;
  className?: string;
}

export function DocumentViewer({
  content,
  onWikiLinkClick,
  className,
}: DocumentViewerProps) {
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
        remarkPlugins={[remarkGfm, remarkStripHtml, remarkWikiLinks]}
        // Cast: Components type keyed on HTML names; `wikilink` not in union.
        components={
          {
            wikilink: ({ children, ...props }: any) => {
              const target = (props["data-wiki-target"] ?? "") as string;
              return (
                <button
                  type="button"
                  className="wiki-link wiki-link-exists bg-transparent border-0 p-0 m-0 cursor-pointer"
                  title={`Open "${target}"`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onWikiLinkClick?.(target);
                  }}
                >
                  {children}
                </button>
              );
            },
            // stopPropagation: block parent click-to-edit on link click.
            a: ({ href, children, ...props }: any) => (
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
    </div>
  );
}
