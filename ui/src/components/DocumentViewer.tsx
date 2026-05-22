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
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import type { Root, Text } from "mdast";
import { visit } from "unist-util-visit";
import { cn } from "@/lib/utils";

const WIKI_LINK_SCHEME = "wiki://";
const wikiLinkRegex = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

/**
 * remark plugin that rewrites `[[Title]]` and `[[Title|Display]]`
 * occurrences inside text nodes into native mdast `link` nodes whose
 * URL is `wiki://<Title>`. React-markdown's `a` component override
 * then renders these as click handlers, so we never have to inject
 * raw HTML (no DOMPurify dance required for our own content).
 */
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
      const title = m[1].trim();
      const display = (m[2] ?? m[1]).trim();
      newChildren.push({
        type: "link",
        url: `${WIKI_LINK_SCHEME}${title}`,
        children: [{ type: "text", value: display }],
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
        // Match the editor's prose styling so view ↔ edit feels continuous.
        "prose prose-sm dark:prose-invert max-w-none px-6 py-4",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkWikiLinks]}
        components={{
          a: ({ href, children, ...props }) => {
            if (href?.startsWith(WIKI_LINK_SCHEME)) {
              const title = decodeURIComponent(
                href.slice(WIKI_LINK_SCHEME.length),
              );
              return (
                <button
                  type="button"
                  className="text-blue-600 hover:underline font-medium"
                  onClick={(e) => {
                    e.preventDefault();
                    onWikiLinkClick?.(title);
                  }}
                >
                  {children}
                </button>
              );
            }
            // Real links: open in a new tab, mark as untrusted-source.
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                {...props}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
