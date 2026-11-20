/**
 * Message search (PO-1200 AC-C3-12, C1 PO-1196): the sidebar's search box,
 * asked with Enter, lists hits here in the conversation's place: the excerpt
 * with the matched words marked, who and where, newest first. A hit opens
 * its thread. "In this channel" narrows to the open one.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hash, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MessageSearchHit } from "../../lib/api";
import { authorOf } from "../../lib/channels";
import { excerptPieces } from "../../lib/chat-messages";
import { relTime } from "../../lib/dates";
import { reads } from "../../lib/queries";
import { EmptyState, ErrorState } from "./States";

export function SearchPane({ nestId, query, channel, onOpen, onClose }: { nestId: string; query: string; channel: string | null; onOpen: (hit: MessageSearchHit) => void; onClose: () => void }) {
  const [onlyHere, setOnlyHere] = useState(false);
  const scope = onlyHere ? channel : null;
  const search = useQuery(reads.chatSearch(nestId, query, scope));
  const hits = search.data?.results ?? [];
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Search results" data-testid="search-pane">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-base font-semibold leading-6">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">“{query}”</span>
          {search.data && (
            <span className="text-sm font-normal text-muted-foreground">
              {hits.length}
              {search.data.pagination.has_more ? "+" : ""}
            </span>
          )}
        </h2>
        {channel && (
          <button
            type="button"
            onClick={() => setOnlyHere((v) => !v)}
            aria-pressed={onlyHere}
            className={cn("h-7 shrink-0 rounded-md border px-2 text-xs font-medium hover:bg-muted", onlyHere && "border-primary/40 bg-primary/10 text-primary")}
            data-testid="search-only-here"
          >
            In #{channel}
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close search" title="Close search (Esc)" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {search.isError ? (
          <ErrorState title="Couldn't search" detail={(search.error as Error)?.message} onRetry={() => void search.refetch()} className="m-4" />
        ) : search.isLoading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground" role="status">
            Searching…
          </p>
        ) : hits.length === 0 ? (
          <EmptyState icon={Search} title="No messages match" hint="Every word has to appear. Try fewer words, or a different spelling." className="h-full" />
        ) : (
          <ul className="divide-y">
            {hits.map((h) => {
              const who = authorOf(h);
              return (
                <li key={h.message_id}>
                  <button type="button" onClick={() => onOpen(h)} className="block w-full px-4 py-2.5 text-left hover:bg-muted/40" data-testid="search-hit">
                    <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-0.5">
                        <Hash className="h-3 w-3" aria-hidden />
                        {h.channel}
                      </span>
                      <span className="font-medium text-foreground">{who.name}</span>
                      <span className="ml-auto">{relTime(h.created_at)}</span>
                    </span>
                    <span className="mt-0.5 block text-sm">
                      {excerptPieces(h.excerpt, h.highlights).map((p, i) =>
                        p.hit ? (
                          <mark key={i} className="rounded-sm bg-amber-100 px-0.5 text-foreground">
                            {p.text}
                          </mark>
                        ) : (
                          <span key={i}>{p.text}</span>
                        ),
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
            {search.data!.pagination.has_more && <li className="px-4 py-3 text-center text-xs text-muted-foreground">Showing the newest {hits.length}. Narrow the words to see older ones.</li>}
          </ul>
        )}
      </div>
    </section>
  );
}
