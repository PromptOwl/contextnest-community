/**
 * My Work's Mentions as an inbox (PO-1180, PO-1200 AC-C3-08): open threads
 * that @mention you, in channels and on documents, grouped by nest. A row
 * opens its thread; "Mark done" clears the row for you without replying, and
 * it only returns if a later message in that thread mentions you again.
 * People show by display name, and the excerpt is one line of plain text.
 */
import { AtSign, Check, ChevronLeft, ChevronRight, FileText, Hash, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MentionItem, WorkPagination } from "../../lib/api";
import { relTime } from "../../lib/dates";
import { groupMentionsByNest, mentionPlace } from "../../lib/my-work-inbox";
import { plainExcerpt, type NamedPerson } from "../../lib/plain-excerpt";

/** Who mentioned you: the display name, with the agent that wrote it if any. */
export function mentionAuthor(m: Pick<MentionItem, "author" | "author_name" | "author_label" | "agent">): string {
  if (m.author_label && !m.author_label.includes("@")) return m.author_label;
  const person = m.author_name || m.author_label || m.author;
  return m.agent ? `${m.agent}, on behalf of ${person}` : person;
}

export function MentionRows({
  mentions,
  viewer,
  pagination,
  loading,
  busyThread,
  onOpen,
  onDone,
  onPage,
}: {
  mentions: MentionItem[];
  /** The signed-in person, so "@their@address" in an excerpt reads as their name. */
  viewer?: NamedPerson | null;
  pagination?: WorkPagination;
  /** A page of mentions is being fetched. */
  loading: boolean;
  /** The thread whose "Mark done" is in flight. */
  busyThread: string | null;
  onOpen: (m: MentionItem) => void;
  onDone: (m: MentionItem) => void;
  onPage: (offset: number) => void;
}) {
  if (mentions.length === 0) return null;
  const groups = groupMentionsByNest(mentions);
  return (
    <section className="rounded-lg border" data-testid="my-work-mentions" aria-label="Mentions">
      <div className="flex h-10 items-center gap-2 px-4 text-sm font-medium">
        <AtSign className="h-4 w-4 text-muted-foreground" aria-hidden />
        Mentions
        <span className="text-xs text-muted-foreground">({pagination?.total ?? mentions.length})</span>
      </div>
      {groups.map((g) => (
        <div key={g.nest_id} className="border-t" data-testid="my-work-mention-group">
          <div className="flex h-7 items-center bg-muted/40 px-4 text-xs font-semibold text-muted-foreground">{g.nest_name}</div>
          <ul className="divide-y">
            {g.rows.map((m) => {
              const busy = busyThread === m.thread_id;
              return (
                <li key={`${m.nest_id}:${m.thread_id}`} className="group flex items-start gap-1 pr-2 hover:bg-muted/40" data-testid="my-work-mention">
                  <button type="button" onClick={() => onOpen(m)} className="flex min-w-0 flex-1 items-start gap-3 px-4 py-2 text-left" title="Open in thread">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      {m.channel ? <Hash className="h-3.5 w-3.5" aria-hidden /> : <FileText className="h-3.5 w-3.5" aria-hidden />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2 leading-5">
                        <span className="truncate text-sm font-medium" title={m.author}>
                          {mentionAuthor(m)}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          in {mentionPlace(m)}
                          {m.for_agent ? ` · for @${m.for_agent}` : ""}
                        </span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{relTime(m.mentioned_at)}</span>
                      </span>
                      <span className="block truncate text-sm text-muted-foreground" data-testid="my-work-mention-excerpt">
                        {plainExcerpt(m.excerpt, [...(viewer ? [viewer] : []), { email: m.author, name: m.author_name }])}
                      </span>
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn("mt-1.5 shrink-0 gap-1 text-muted-foreground hover:text-foreground", !busy && "sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100")}
                    disabled={busy}
                    onClick={() => onDone(m)}
                    title="Clear this mention from My Work. The message stays."
                    data-testid="my-work-mention-done"
                  >
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    Mark done
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {pagination && pagination.total > pagination.limit && (
        <div className="flex items-center justify-end gap-2 border-t px-4 py-1.5 text-xs text-muted-foreground">
          <span>
            {pagination.offset + 1}–{pagination.offset + mentions.length} of {pagination.total}
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-1.5" disabled={loading || pagination.offset === 0} onClick={() => onPage(Math.max(0, pagination.offset - pagination.limit))} aria-label="Previous mentions">
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-1.5" disabled={loading || !pagination.has_more} onClick={() => onPage(pagination.offset + pagination.limit)} aria-label="More mentions">
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </section>
  );
}
