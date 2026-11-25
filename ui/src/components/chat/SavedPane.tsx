/**
 * Saved messages (PO-1200 AC-C3-12, C1 PO-1196): the reader's own, newest
 * first across every nest they can read, in the conversation's place when
 * "Saved" is chosen in the sidebar. A row opens the message's thread; the
 * bookmark on the row unsaves it.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, BookmarkX, Hash, X } from "lucide-react";
import { toast } from "sonner";
import type { SavedItem } from "../../lib/api";
import * as api from "../../lib/api";
import { authorOf } from "../../lib/channels";
import { relTime } from "../../lib/dates";
import { plainExcerpt } from "../../lib/plain-excerpt";
import { keys, reads } from "../../lib/queries";
import { EmptyState, ErrorState } from "./States";

export function SavedPane({ onOpen, onClose }: { onOpen: (item: SavedItem) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const saved = useQuery(reads.mySaved());
  const unsave = async (item: SavedItem) => {
    try {
      await api.setMessageSaved(item.nest_id, item.channel, item.message.id, false);
      qc.setQueryData<{ saved: SavedItem[]; pagination: api.ChannelPagination }>(keys.mySaved(), (d) =>
        d ? { ...d, saved: d.saved.filter((s) => s.message.id !== item.message.id), pagination: { ...d.pagination, total: Math.max(0, d.pagination.total - 1) } } : d,
      );
    } catch (e) {
      toast.error((e as Error)?.message || "Could not unsave the message");
    }
  };
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Saved messages" data-testid="saved-pane">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <h2 className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-base font-semibold leading-6">
          <Bookmark className="h-4 w-4 text-muted-foreground" aria-hidden /> Saved
          {saved.data && <span className="text-sm font-normal text-muted-foreground">{saved.data.pagination.total}</span>}
        </h2>
        <button type="button" onClick={onClose} aria-label="Back to the channel" title="Back to the channel (Esc)" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {saved.isError ? (
          <ErrorState title="Couldn't load saved messages" detail={(saved.error as Error)?.message} onRetry={() => void saved.refetch()} className="m-4" />
        ) : saved.isLoading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground" role="status">
            Loading…
          </p>
        ) : saved.data!.saved.length === 0 ? (
          <EmptyState icon={Bookmark} title="Nothing saved yet" hint="Save a message from its actions to find it here later." className="h-full" />
        ) : (
          <ul className="divide-y">
            {saved.data!.saved.map((item) => {
              const who = authorOf(item.message);
              return (
                <li key={item.message.id} className="group flex items-start gap-1 pr-2 hover:bg-muted/40" data-testid="saved-row">
                  <button type="button" onClick={() => onOpen(item)} className="min-w-0 flex-1 px-4 py-2.5 text-left">
                    <span className="flex items-baseline gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-0.5">
                        <Hash className="h-3 w-3" aria-hidden />
                        {item.channel}
                      </span>
                      <span>· {item.nest_name}</span>
                      <span className="ml-auto">saved {relTime(item.saved_at)}</span>
                    </span>
                    <span className="mt-0.5 flex items-baseline gap-2">
                      <span className="text-sm font-medium">{who.name}</span>
                      <span className="text-xs text-muted-foreground">{relTime(item.message.created_at)}</span>
                    </span>
                    <span className="line-clamp-2 block text-sm text-foreground/90">{plainExcerpt(item.message.body, [{ email: item.message.author, name: item.message.author_name }])}</span>
                  </button>
                  <button type="button" onClick={() => void unsave(item)} aria-label="Unsave" title="Unsave" className="mt-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100" data-testid="saved-remove">
                    <BookmarkX className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
