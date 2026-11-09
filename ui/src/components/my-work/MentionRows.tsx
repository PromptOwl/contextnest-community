/**
 * My Work's Mentions: open threads that @mention you, in channels and on
 * documents (PO-1180). A row opens its thread; "Mark done" (PO-1189) clears
 * the row for you without replying, and it only returns if a later message in
 * that thread mentions you again. People show by display name, and the
 * excerpt is one line of plain text (no markdown, no full addresses).
 */
import { Check, ChevronLeft, ChevronRight, Loader2, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { MentionItem, WorkPagination } from "../../lib/api";
import { relTime } from "../../lib/dates";
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
  return (
    <div className="rounded-lg border" data-testid="my-work-mentions">
      <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium">
        Mentions
        <span className="text-xs text-muted-foreground">({pagination?.total ?? mentions.length})</span>
      </div>
      <ul className="divide-y border-t">
        {mentions.map((m) => (
          <li key={`${m.nest_id}:${m.thread_id}`} className="flex items-start gap-1 pr-2 hover:bg-muted/50" data-testid="my-work-mention">
            <button
              type="button"
              onClick={() => onOpen(m)}
              className="flex min-w-0 flex-1 items-start gap-2 px-4 py-2 text-left text-sm"
            >
              <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  <span className="font-medium" title={m.author}>
                    {mentionAuthor(m)}
                  </span>
                  <span className="text-muted-foreground">
                    {" in "}
                    {m.channel ? `#${m.channel}` : m.title}
                    {m.for_agent ? ` · for @${m.for_agent}` : ""}
                  </span>
                </span>
                <span className="block truncate text-muted-foreground" data-testid="my-work-mention-excerpt">
                  {plainExcerpt(m.excerpt, [...(viewer ? [viewer] : []), { email: m.author, name: m.author_name }])}
                </span>
                <span className="block text-xs text-muted-foreground sm:hidden">
                  {m.nest_name} · {relTime(m.mentioned_at)}
                </span>
              </span>
              <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                {m.nest_name} · {relTime(m.mentioned_at)}
              </span>
            </button>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 shrink-0 gap-1 text-muted-foreground hover:text-foreground"
              disabled={busyThread === m.thread_id}
              onClick={() => onDone(m)}
              title="Clear this mention from My Work. The message stays."
              data-testid="my-work-mention-done"
            >
              {busyThread === m.thread_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Mark done
            </Button>
          </li>
        ))}
      </ul>
      {pagination && pagination.total > pagination.limit && (
        <div className="flex items-center justify-end gap-2 border-t px-4 py-1.5 text-xs text-muted-foreground">
          <span>
            {pagination.offset + 1}–{pagination.offset + mentions.length} of {pagination.total}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            disabled={loading || pagination.offset === 0}
            onClick={() => onPage(Math.max(0, pagination.offset - pagination.limit))}
            aria-label="Previous mentions"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            disabled={loading || !pagination.has_more}
            onClick={() => onPage(pagination.offset + pagination.limit)}
            aria-label="More mentions"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
