/**
 * Artifact cards under a message (PO-1181, agent team stream S3): the nest
 * artifacts a message links, as the server resolved them for THIS viewer.
 *
 * A resolved card shows title, type, stage and version and opens the node.
 * An unresolved one shows only the link text the message already contains —
 * the server never sends a title for a node the viewer can't read, and this
 * component never guesses one. Everything renders as text nodes.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, LayoutTemplate, Link2Off } from "lucide-react";
import * as api from "../lib/api";
import type { ArtifactCard } from "../lib/api";

/** Only an in-app path the server built (`/nest/<id>?doc=…`) becomes a link. */
function safeAppPath(url: string): string | null {
  return /^\/nest\/[^/?#]+\?doc=/.test(url) ? url : null;
}

export function ArtifactCards({ cards }: { cards?: ArtifactCard[] }) {
  if (!cards?.length) return null;
  return (
    <ul className="mt-1.5 space-y-1" aria-label="Linked artifacts">
      {cards.map((c, i) =>
        c.resolved ? (
          <li key={`${c.link}-${i}`}>
            <a
              href={safeAppPath(c.url) ?? undefined}
              // min-h-8: a finger-sized row on a phone; the compact one beside a pointer.
              className="flex min-h-8 max-w-md items-center gap-2 rounded border bg-muted/30 px-2 py-1 text-xs hover:bg-muted sm:min-h-0"
            >
              {c.kind === "artifact" ? (
                <LayoutTemplate className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate font-medium">{c.title}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">
                {[c.type, c.stage, c.version ? `v${c.version}` : null].filter(Boolean).join(" · ")}
              </span>
            </a>
          </li>
        ) : (
          <li key={`${c.link}-${i}`} className="flex max-w-md items-center gap-2 px-2 py-0.5 text-xs text-muted-foreground">
            <Link2Off className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{c.link}</span>
            <span className="shrink-0">· not available</span>
          </li>
        ),
      )}
    </ul>
  );
}

/** Could this text hold a card-able link? A cheap client-side pre-check, so a
 *  thread with none makes no request; the server does the real extraction. */
export function mayHaveCards(body: string): boolean {
  return body.includes("[[") || /https?:\/\/\S+\/nests?\//.test(body);
}

/**
 * Cards for a set of comments (document comment threads), in one request.
 * Returns comment id → cards.
 */
export function useCommentCards(
  nestId: string,
  comments: Array<{ id: string; body: string }>,
): Map<string, ArtifactCard[]> {
  const wanted = useMemo(() => comments.filter((c) => mayHaveCards(c.body)), [comments]);
  const key = wanted.map((c) => c.id).join(",");
  const { data } = useQuery({
    queryKey: ["artifact-cards", nestId, key],
    queryFn: () => api.resolveMessageCards(nestId, wanted.map((c) => c.body)),
    enabled: !!nestId && wanted.length > 0,
    staleTime: 30_000,
  });
  return useMemo(() => {
    const out = new Map<string, ArtifactCard[]>();
    data?.messages.forEach((m, i) => {
      const id = wanted[i]?.id;
      if (id) out.set(id, m.cards);
    });
    return out;
  }, [data, wanted]);
}
