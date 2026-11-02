/**
 * Hootie's answer text as markdown — a whitelist renderer.
 *
 * The answer is model-written, and any document the asker can read can try
 * to steer the model. So nothing in an answer is fetched by the browser or
 * made clickable unless the server resolved it: an image is its alt text
 * (an auto-loading `<img src="https://…?d=<nest text>">` would exfiltrate
 * with no click); a link, autolink or raw URL is its text; and a `#cite:`
 * link is a chip only for an id in `cited` — the nodes the server resolved
 * from what it retrieved for this caller. `[[X]]` links that resolve against
 * `cited` become those `#cite:` links (see linkCitations).
 */
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { linkCitations, type CitableNode } from "@/lib/hootie-panel";

/** The cited id a `#cite:` href names, or null (not a cite, malformed). */
function citeId(href: string | undefined): string | null {
  if (!href?.startsWith("#cite:")) return null;
  try {
    return decodeURIComponent(href.slice(6));
  } catch {
    return null;
  }
}

export function HootieAnswerMarkdown({
  content,
  cited,
  nestId,
  onOpenNode,
}: {
  content: string;
  /** The server's citations; undefined while the answer streams. */
  cited: readonly CitableNode[] | undefined;
  nestId: string;
  onOpenNode: (nestId: string, nodeId: string) => void;
}) {
  const source = linkCitations(content, cited);
  const citedIds = new Set((cited ?? []).map((n) => n.id));
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Never fetched: the alt text stands in for the image.
        img: ({ alt }) => <>{alt ?? ""}</>,
        a: ({ href, children }: { href?: string; children?: ReactNode }) => {
          const id = citeId(href);
          if (id === null || !citedIds.has(id)) return <>{children}</>;
          return (
            <button
              type="button"
              onClick={() => onOpenNode(nestId, id)}
              className="inline-flex items-center rounded-md border border-primary/20 bg-primary/5 px-1.5 py-0.5 align-baseline text-xs font-medium text-primary no-underline hover:bg-primary/10"
              data-testid="hootie-citation"
            >
              {children}
            </button>
          );
        },
      }}
    >
      {source}
    </ReactMarkdown>
  );
}
