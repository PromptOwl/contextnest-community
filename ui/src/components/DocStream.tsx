/**
 * DocStream — the experimental cross-nest document stream (CU-wdqcq02crv).
 *
 * One card per document version from GET /me/stream, newest first, with
 * multi-select filter chips (nest / topic / type / author) built from the
 * server's per-facet counts, "load more" paging, and the document's open
 * comment threads inline with a composer. The Stream page renders it across
 * every nest; a nest's Stream tab renders it with `pinnedNestId`.
 *
 * Shown only while /health says experimental.doc_stream — the caller gates.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageSquare, ExternalLink, X } from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import { reads, keys } from "../lib/queries";
import { relTime } from "../lib/dates";
import {
  EMPTY_STREAM_FILTERS,
  mergeStreamPages,
  toggleFacet,
  type StreamFacetKey,
  type StreamFilters,
} from "../lib/doc-stream";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MentionTextarea, CommentBody } from "./MentionTextarea";
import type { MentionMember } from "./MarkdownEditor/picker-match";

const PAGE_SIZE = 25;

const KIND_LABEL: Record<api.StreamKind, string> = {
  created: "created",
  updated: "edited",
  published: "published",
  approved: "approved",
  rejected: "rejected",
};

export interface DocStreamProps {
  /** Fix the stream to one nest (the nest's Stream tab). */
  pinnedNestId?: string;
  /** Open the document, optionally with a comment thread focused. */
  onOpen: (item: api.StreamItem, threadId?: string) => void;
}

export function DocStream({ pinnedNestId, onOpen }: DocStreamProps) {
  const [filters, setFilters] = useState<StreamFilters>(EMPTY_STREAM_FILTERS);
  const [items, setItems] = useState<api.StreamItem[]>([]);
  const [page, setPage] = useState<api.StreamPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  // A filter change while a page is in flight must not let the stale answer
  // land over the fresh one.
  const seq = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const mine = ++seq.current;
      if (offset === 0) setLoading(true);
      else setLoadingMore(true);
      try {
        const next = await api.getDocStream({ ...filters, limit: PAGE_SIZE, offset }, pinnedNestId);
        if (mine !== seq.current) return;
        // Later pages carry no counts: keep the first page's chips.
        setPage((prev) => (next.counts || !prev ? next : { ...next, counts: prev.counts }));
        setItems((prev) => (offset === 0 ? next.items : mergeStreamPages(prev, next.items)));
        setError(null);
      } catch (e) {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e.message : "Couldn't load the stream.");
      } finally {
        if (mine === seq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filters, pinnedNestId],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const toggle = (key: StreamFacetKey, value: string) => setFilters((f) => toggleFacet(f, key, value));
  const anyFilter = (Object.keys(filters) as StreamFacetKey[]).some((k) => filters[k].length > 0);
  const counts = page?.counts;

  const facets: Array<{ key: StreamFacetKey; label: string; options: Array<{ value: string; label: string; count: number }> }> =
    useMemo(
      () =>
        counts
          ? [
              ...(pinnedNestId
                ? []
                : [{ key: "nest" as const, label: "Nest", options: counts.nest.map((n) => ({ value: n.id, label: n.name, count: n.count })) }]),
              { key: "tag" as const, label: "Topic", options: counts.tag.map((t) => ({ value: t.value, label: `#${t.value}`, count: t.count })) },
              { key: "type" as const, label: "Type", options: counts.type.map((t) => ({ value: t.value, label: t.value, count: t.count })) },
              { key: "author" as const, label: "Author", options: counts.author.map((a) => ({ value: a.value, label: a.value, count: a.count })) },
            ].filter((f) => f.options.length > 0)
          : [],
      [counts, pinnedNestId],
    );

  return (
    <div className="space-y-4" data-testid="doc-stream">
      {facets.length > 0 && (
        <div className="space-y-2" aria-label="Filter the stream">
          {facets.map((f) => (
            <div key={f.key} className="flex flex-wrap items-center gap-1.5">
              <span className="w-14 shrink-0 text-xs font-medium text-muted-foreground">{f.label}:</span>
              {f.options.map((o) => {
                const on = filters[f.key].includes(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggle(f.key, o.value)}
                    className={`inline-flex h-6 max-w-[16rem] items-center gap-1 rounded-full border px-2 text-xs transition-colors ${
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground hover:text-foreground"
                    }`}
                    data-testid={`stream-chip-${f.key}`}
                  >
                    <span className="truncate">{o.label}</span>
                    <span className={on ? "opacity-80" : "opacity-60"}>{o.count}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {anyFilter && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setFilters(EMPTY_STREAM_FILTERS)}
            >
              <X className="h-3 w-3" /> Clear filters
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the stream…
        </div>
      ) : error ? (
        <div className="py-12 text-center text-sm text-destructive">{error}</div>
      ) : items.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {anyFilter ? "Nothing matches these filters." : "No document activity yet."}
        </div>
      ) : (
        <ol className="space-y-3">
          {items.map((item) => (
            <StreamCard
              key={item.id}
              item={item}
              showNest={!pinnedNestId}
              expanded={expanded === item.id}
              onToggleComments={() => setExpanded((cur) => (cur === item.id ? null : item.id))}
              onOpen={onOpen}
              onCommented={() =>
                // Every card of the same document shows the same threads.
                setItems((prev) =>
                  prev.map((i) =>
                    i.nestId === item.nestId && i.nodeId === item.nodeId
                      ? { ...i, commentCount: (i.commentCount ?? 0) + 1 }
                      : i,
                  ),
                )
              }
            />
          ))}
        </ol>
      )}

      {!loading && page?.has_more && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void load(items.length)}>
            {loadingMore && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Load more
          </Button>
        </div>
      )}
      {!loading && page && items.length > 0 && (
        <p className="text-center text-xs text-muted-foreground">
          Showing {items.length} of {page.total}
        </p>
      )}
    </div>
  );
}

function StreamCard({
  item,
  showNest,
  expanded,
  onToggleComments,
  onOpen,
  onCommented,
}: {
  item: api.StreamItem;
  showNest: boolean;
  expanded: boolean;
  onToggleComments: () => void;
  onOpen: (item: api.StreamItem, threadId?: string) => void;
  onCommented: () => void;
}) {
  return (
    <li className="rounded-lg border bg-card p-4" data-testid="stream-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {showNest && (
          <Badge variant="secondary" className="max-w-[12rem] truncate text-[11px]">
            {item.nestName}
          </Badge>
        )}
        <span>
          {item.author ?? "Someone"} {KIND_LABEL[item.kind]} v{item.version}
        </span>
        <span aria-hidden>·</span>
        <time dateTime={item.at} title={item.at}>
          {relTime(item.at)}
        </time>
        {(item.status === "draft" || item.status === "pending_review") && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {item.status === "draft" ? "draft" : "in review"}
          </Badge>
        )}
      </div>
      <button
        type="button"
        className="mt-1 block text-left text-base font-medium hover:underline"
        onClick={() => onOpen(item)}
      >
        {item.title}
      </button>
      {item.summary && <p className="mt-1 text-sm text-muted-foreground line-clamp-3">{item.summary}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {item.type !== "document" && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{item.type}</span>
        )}
        {item.tags.map((t) => (
          <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            #{t}
          </span>
        ))}
        {item.commentCount !== null && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            onClick={onToggleComments}
            title="Open comments on this document (all its versions)"
            data-testid="stream-comments-toggle"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {item.commentCount === 1 ? "1 comment" : `${item.commentCount} comments`}
          </button>
        )}
      </div>
      {expanded && item.commentCount !== null && (
        <StreamComments item={item} onOpen={onOpen} onCommented={onCommented} />
      )}
    </li>
  );
}

/** The document's open threads (the same ones its comment rail shows) and a
 *  composer: a reply goes on the chosen thread, otherwise a new whole-document
 *  thread is started — both through the existing annotations endpoints. */
function StreamComments({
  item,
  onOpen,
  onCommented,
}: {
  item: api.StreamItem;
  onOpen: (item: api.StreamItem, threadId?: string) => void;
  onCommented: () => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(reads.nodeAnnotations(item.nestId, item.nodeId));
  const { data: roster } = useQuery(reads.mentionable(item.nestId));
  const members: MentionMember[] = useMemo(
    () => (roster?.people ?? []).filter((p) => !!p.email),
    [roster],
  );
  const open = (data?.threads ?? []).filter((t) => t.status === "open");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const post = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      if (replyTo) await api.replyAnnotation(item.nestId, item.nodeId, replyTo, body);
      else await api.createAnnotation(item.nestId, item.nodeId, { body, anchor: null });
      setText("");
      setReplyTo(null);
      onCommented();
      await qc.invalidateQueries({ queryKey: keys.nodeAnnotations(item.nestId, item.nodeId) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't post the comment.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-3 border-t pt-3">
      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading comments…</div>
      ) : open.length === 0 ? (
        <div className="text-xs text-muted-foreground">No open comments yet.</div>
      ) : (
        <ul className="space-y-2">
          {open.map((t) => (
            <li key={t.id} className="rounded-md bg-muted/40 p-2 text-sm">
              {t.anchor?.quote && (
                <div className="mb-1 border-l-2 pl-2 text-xs italic text-muted-foreground line-clamp-2">
                  {t.anchor.quote}
                </div>
              )}
              {t.comments.map((c) => (
                <div key={c.id} className="mb-1 last:mb-0">
                  <span className="text-xs font-medium">{c.author}</span>{" "}
                  <span className="text-xs text-muted-foreground">{relTime(c.createdAt)}</span>
                  <CommentBody body={c.body} members={members} className="text-sm" />
                </div>
              ))}
              <div className="mt-1 flex gap-3 text-xs">
                <button
                  type="button"
                  className={replyTo === t.id ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}
                  onClick={() => setReplyTo((cur) => (cur === t.id ? null : t.id))}
                >
                  {replyTo === t.id ? "Replying…" : "Reply"}
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  onClick={() => onOpen(item, t.id)}
                >
                  <ExternalLink className="h-3 w-3" /> Open thread
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2">
        <MentionTextarea
          formatting
          members={members}
          value={text}
          onValueChange={setText}
          placeholder={replyTo ? "Reply… use @ to tag someone" : "Comment on this document… use @ to tag someone"}
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
          data-testid="stream-composer"
        />
        <div className="flex justify-end gap-2">
          {replyTo && (
            <Button variant="ghost" size="sm" onClick={() => setReplyTo(null)}>
              New comment instead
            </Button>
          )}
          <Button size="sm" disabled={busy || !text.trim()} onClick={() => void post()}>
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {replyTo ? "Reply" : "Comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}
