/**
 * DocStream — the experimental cross-nest document stream (CU-wdqcq02crv),
 * rebuilt as a feed (po-1214).
 *
 * One post per document version from GET /me/stream, newest first: an avatar
 * column, "name · via agent · nest · time" on one line, what happened to which
 * document on the next, a clamped excerpt, and a quiet action row — reply in
 * place (the document's annotation threads + the @mention composer), approve
 * or request changes on an in-review post when the reader may review, open,
 * copy link. Filters are one row: a people / agents toggle, the active chips,
 * and a Filter menu holding the nest / topic / type / author facets. New posts
 * arrive as an "N new posts" pill (a cheap `since` + `facets=0` poll).
 *
 * The Stream page renders it across every nest; a nest's Stream tab renders
 * it with `pinnedNestId`. Shown only while /health says experimental.doc_stream
 * — the caller gates.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  ArrowUpRight,
  Bot,
  Check,
  Link2,
  Loader2,
  MessageSquare,
  SlidersHorizontal,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import { reads, keys } from "../lib/queries";
import { formatServerDate, SHORT_DATE_TIME } from "../lib/dates";
import { documentLink } from "../lib/nest-url";
import { displayNameFor } from "../lib/person-name";
import {
  EMPTY_STREAM_FILTERS,
  activeFilterCount,
  compactTime,
  initialsOf,
  mergeStreamPages,
  newPostCount,
  postAction,
  postIdentity,
  toggleFacet,
  type StreamFacetKey,
  type StreamFilters,
  type StreamSource,
} from "../lib/doc-stream";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MentionTextarea, CommentBody } from "./MentionTextarea";
import type { MentionMember } from "./MarkdownEditor/picker-match";

const PAGE_SIZE = 25;
/** How often the feed asks "anything newer?" — one COUNT and one row. */
const POLL_MS = 30_000;

export interface DocStreamProps {
  /** Fix the stream to one nest (the nest's Stream tab). */
  pinnedNestId?: string;
  /** Open the document, optionally with a comment thread focused. */
  onOpen: (item: api.StreamItem, threadId?: string) => void;
}

type FacetOption = { value: string; label: string; count: number };

export function DocStream({ pinnedNestId, onOpen }: DocStreamProps) {
  const [filters, setFilters] = useState<StreamFilters>(EMPTY_STREAM_FILTERS);
  const [source, setSource] = useState<StreamSource | undefined>(undefined);
  const [items, setItems] = useState<api.StreamItem[]>([]);
  const [page, setPage] = useState<api.StreamPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [fresh, setFresh] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  // A filter change while a page is in flight must not let the stale answer
  // land over the fresh one.
  const seq = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const mine = ++seq.current;
      if (offset === 0) setLoading(true);
      else setLoadingMore(true);
      try {
        const next = await api.getDocStream({ ...filters, source, limit: PAGE_SIZE, offset }, pinnedNestId);
        if (mine !== seq.current) return;
        // Later pages carry no counts: keep the first page's chips.
        setPage((prev) => (next.counts || !prev ? next : { ...next, counts: prev.counts }));
        setItems((prev) => (offset === 0 ? next.items : mergeStreamPages(prev, next.items)));
        if (offset === 0) setFresh(0);
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
    [filters, source, pinnedNestId],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  // The new-posts pill: while the tab is visible, ask how many versions are
  // at or after the newest one shown. Never reloads the list by itself — a
  // feed that jumps under the reader's thumb is worse than a stale one.
  const newest = items[0]?.at;
  useEffect(() => {
    if (!newest) return;
    let stop = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const p = await api.getDocStream(
          { ...filters, source, since: newest, limit: 1, facets: false },
          pinnedNestId,
        );
        if (!stop) setFresh(newPostCount(items, newest, p.total));
      } catch (e) {
        // A failed poll leaves the pill as it was; the next tick tries again.
        console.warn("[stream] new-posts poll failed", e);
      }
    };
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [newest, items, filters, source, pinnedNestId]);

  const showFresh = () => {
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    void load(0);
  };

  const counts = page?.counts;
  const facets: Array<{ key: StreamFacetKey; label: string; options: FacetOption[] }> = useMemo(
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
  const toggle = (key: StreamFacetKey, value: string) => setFilters((f) => toggleFacet(f, key, value));
  const nFilters = activeFilterCount(filters);
  const anyFilter = nFilters > 0 || !!source;

  // Chips in the row: the switched-on values (each with an ×); with nothing
  // on, the top few of the first facet as shortcuts.
  const labelOf = (key: StreamFacetKey, value: string) =>
    facets.find((f) => f.key === key)?.options.find((o) => o.value === value)?.label ?? value;
  const activeChips = (Object.keys(filters) as StreamFacetKey[]).flatMap((k) =>
    filters[k].map((v) => ({ key: k, value: v, label: labelOf(k, v) })),
  );
  const first = facets[0];
  const shortcuts = nFilters === 0 && first ? first.options.slice(0, 3).map((o) => ({ key: first.key, ...o })) : [];

  // A post changed in place (approve, request changes).
  const patch = (id: string, fn: (i: api.StreamItem) => api.StreamItem) =>
    setItems((prev) => prev.map((i) => (i.id === id ? fn(i) : i)));

  return (
    <div className="max-w-3xl" data-testid="doc-stream">
      <div ref={top} className="scroll-mt-20" />
      <div
        className="flex items-center gap-1.5 overflow-x-auto pb-2 [scrollbar-width:none]"
        aria-label="Filter the stream"
      >
        <div role="radiogroup" aria-label="Who wrote it" className="inline-flex h-7 shrink-0 items-center rounded-md border p-0.5 text-xs">
          {([
            [undefined, "All"],
            ["human", "People"],
            ["agent", "Agents"],
          ] as const).map(([value, label]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={source === value}
              onClick={() => setSource(value)}
              className={`h-6 rounded px-2.5 transition-colors ${
                source === value ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`stream-source-${label.toLowerCase()}`}
            >
              {label}
            </button>
          ))}
        </div>
        {activeChips.map((c) => (
          <button
            key={`${c.key}:${c.value}`}
            type="button"
            aria-pressed
            onClick={() => toggle(c.key, c.value)}
            className="inline-flex h-7 max-w-[12rem] shrink-0 items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2 text-xs text-foreground"
            data-testid={`stream-chip-${c.key}`}
            title="Remove this filter"
          >
            <span className="truncate">{c.label}</span>
            <X className="h-3 w-3 shrink-0 opacity-60" />
          </button>
        ))}
        {shortcuts.map((o) => (
          <button
            key={`${o.key}:${o.value}`}
            type="button"
            aria-pressed={false}
            onClick={() => toggle(o.key, o.value)}
            className="inline-flex h-7 max-w-[12rem] shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            data-testid={`stream-chip-${o.key}`}
          >
            <span className="truncate">{o.label}</span>
          </button>
        ))}
        {facets.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                data-testid="stream-filter-menu"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Filter
                {nFilters > 0 && <span className="rounded bg-muted px-1 tabular-nums text-foreground">{nFilters}</span>}
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="max-h-80 overflow-y-auto py-1">
                {facets.map((f) => (
                  <div key={f.key} className="py-1">
                    <div className="px-3 pb-0.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {f.label}
                    </div>
                    {f.options.map((o) => {
                      const on = filters[f.key].includes(o.value);
                      return (
                        <button
                          key={o.value}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={on}
                          onClick={() => toggle(f.key, o.value)}
                          className="flex w-full items-center gap-2 px-3 py-1 text-left text-sm hover:bg-muted"
                        >
                          <Check className={`h-3.5 w-3.5 shrink-0 ${on ? "opacity-100" : "opacity-0"}`} />
                          <span className="min-w-0 flex-1 truncate">{o.label}</span>
                          <span className="tabular-nums text-xs text-muted-foreground">{o.count}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
        {anyFilter && (
          <button
            type="button"
            className="ml-auto h-7 shrink-0 px-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setFilters(EMPTY_STREAM_FILTERS);
              setSource(undefined);
            }}
          >
            Clear
          </button>
        )}
      </div>

      {fresh > 0 && (
        <div className="pointer-events-none sticky top-3 z-10 flex justify-center">
          <button
            type="button"
            onClick={showFresh}
            className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm"
            data-testid="stream-new-posts"
          >
            <ArrowUp className="h-3.5 w-3.5" />
            {fresh === 1 ? "1 new post" : `${fresh} new posts`}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the stream…
        </div>
      ) : error ? (
        <div className="py-12 text-center text-sm text-destructive">{error}</div>
      ) : items.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {anyFilter ? "Nothing matches these filters." : "No document activity yet."}
        </div>
      ) : (
        <ol className="divide-y border-y">
          {items.map((item) => (
            <StreamPost
              key={item.id}
              item={item}
              showNest={!pinnedNestId}
              expanded={expanded === item.id}
              onToggleReplies={() => setExpanded((cur) => (cur === item.id ? null : item.id))}
              onOpen={onOpen}
              onCommented={() =>
                // Every post of the same document shows the same threads.
                setItems((prev) =>
                  prev.map((i) =>
                    i.nestId === item.nestId && i.nodeId === item.nodeId
                      ? { ...i, commentCount: (i.commentCount ?? 0) + 1 }
                      : i,
                  ),
                )
              }
              onReviewed={(status) =>
                // Say what just happened, as the server will on the next read.
                patch(item.id, (i) => ({ ...i, status, kind: status === "rejected" ? "rejected" : "approved", review: null }))
              }
            />
          ))}
        </ol>
      )}

      {!loading && page?.has_more && (
        <div className="flex justify-center pt-3">
          <Button variant="ghost" size="sm" disabled={loadingMore} onClick={() => void load(items.length)}>
            {loadingMore && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Show more
          </Button>
        </div>
      )}
    </div>
  );
}

/** The person's initials; an agent post wears the agent's mark at the corner. */
function PostAvatar({ name, agent }: { name: string; agent: string | null }) {
  return (
    <div className="relative mt-0.5 h-8 w-8 shrink-0">
      <div
        className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground"
        aria-hidden
      >
        {initialsOf(name)}
      </div>
      {agent && (
        <span
          className="absolute -bottom-1 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-background ring-1 ring-border"
          title={`Written through ${agent}`}
          data-testid="stream-post-agent-mark"
        >
          <Bot className="h-2.5 w-2.5 text-muted-foreground" />
        </span>
      )}
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  children,
  onClick,
  active,
  ...rest
}: {
  icon: typeof MessageSquare;
  label: string;
  children?: React.ReactNode;
  onClick: () => void;
  active?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-full px-2 text-xs transition-colors disabled:opacity-50 sm:h-6 sm:min-w-6 ${
        active ? "text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
      {...rest}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

export function StreamPost({
  item,
  showNest,
  expanded,
  onToggleReplies,
  onOpen,
  onCommented,
  onReviewed,
}: {
  item: api.StreamItem;
  showNest: boolean;
  expanded: boolean;
  onToggleReplies: () => void;
  onOpen: (item: api.StreamItem, threadId?: string) => void;
  onCommented: () => void;
  onReviewed: (status: string) => void;
}) {
  const { name, agent } = postIdentity(item);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const inReview = item.status === "pending_review";
  const canReview = inReview && item.review?.canReview === true;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(documentLink(window.location.origin, item.nestId, item.nodeId));
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link.");
    }
  };
  const approve = async () => {
    setBusy("approve");
    try {
      await api.approveNode(item.nestId, item.nodeId);
      toast.success(`Approved "${item.title}"`);
      onReviewed("published");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't approve.");
    } finally {
      setBusy(null);
    }
  };
  const requestChanges = async () => {
    const text = note.trim();
    if (!text) return;
    setBusy("reject");
    try {
      await api.rejectNode(item.nestId, item.nodeId, text);
      toast.success("Changes requested");
      setAsking(false);
      setNote("");
      onReviewed("rejected");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't request changes.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="flex gap-3 px-2 pb-0.5 pt-2 transition-colors hover:bg-muted/30 sm:px-3" data-testid="stream-post">
      <PostAvatar name={name} agent={agent} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1 text-sm leading-5">
          <span className="max-w-[60%] shrink-0 truncate font-medium" title={item.author ?? undefined}>
            {name}
          </span>
          {agent && (
            <span className="min-w-0 shrink truncate text-muted-foreground" data-testid="stream-post-agent">
              via {agent}
            </span>
          )}
          {showNest && (
            // Phones keep the line for the name and the agent; the nest
            // moves to the end of the next line there.
            <>
              <span className="hidden text-muted-foreground sm:inline" aria-hidden>
                ·
              </span>
              <span className="hidden min-w-0 shrink truncate text-muted-foreground sm:inline">{item.nestName}</span>
            </>
          )}
          <span className="text-muted-foreground" aria-hidden>
            ·
          </span>
          <time
            className="shrink-0 text-muted-foreground"
            dateTime={item.at}
            title={formatServerDate(item.at, SHORT_DATE_TIME)}
          >
            {compactTime(item.at)}
          </time>
          {(item.status === "draft" || inReview) && (
            <span className="ml-1 shrink-0 self-center rounded border px-1 text-[10px] leading-4 text-muted-foreground">
              {inReview ? "in review" : "draft"}
            </span>
          )}
        </div>
        <div className="line-clamp-2 break-words text-sm leading-5 sm:line-clamp-1">
          <span className="text-muted-foreground">{postAction(item)} </span>
          <button
            type="button"
            className="inline text-left font-medium hover:underline"
            onClick={() => onOpen(item)}
            data-testid="stream-post-title"
          >
            {item.title}
          </button>
          {item.changeNote && <span className="text-muted-foreground"> — {item.changeNote}</span>}
          {showNest && <span className="text-muted-foreground sm:hidden"> · {item.nestName}</span>}
        </div>
        {item.summary && (
          <p className="line-clamp-2 text-[13px] leading-5 text-muted-foreground sm:line-clamp-1">{item.summary}</p>
        )}

        <div className="-ml-2 flex items-center gap-0.5">
          {item.commentCount !== null && (
            <ActionButton
              icon={MessageSquare}
              label={expanded ? "Hide replies" : "Reply"}
              onClick={onToggleReplies}
              active={expanded}
              aria-expanded={expanded}
              data-testid="stream-reply"
            >
              {item.commentCount > 0 && <span className="tabular-nums">{item.commentCount}</span>}
            </ActionButton>
          )}
          {canReview && (
            <>
              <ActionButton icon={Check} label="Approve" onClick={() => void approve()} disabled={busy !== null} data-testid="stream-approve">
                {busy === "approve" ? <Loader2 className="h-3 w-3 animate-spin" /> : <span>Approve</span>}
              </ActionButton>
              <ActionButton
                icon={Undo2}
                label="Request changes"
                onClick={() => setAsking((v) => !v)}
                active={asking}
                disabled={busy !== null}
                data-testid="stream-request-changes"
              >
                <span className="hidden sm:inline">Request changes</span>
              </ActionButton>
            </>
          )}
          <span className="flex-1" />
          <ActionButton icon={ArrowUpRight} label="Open" onClick={() => onOpen(item)} data-testid="stream-open" />
          <ActionButton icon={Link2} label="Copy link" onClick={() => void copyLink()} data-testid="stream-copy-link" />
        </div>

        {asking && (
          <div className="mb-2 flex items-start gap-2">
            <textarea
              autoFocus
              rows={1}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What needs to change?"
              className="min-h-8 flex-1 resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              data-testid="stream-request-note"
            />
            <Button size="sm" className="h-8" disabled={busy !== null || !note.trim()} onClick={() => void requestChanges()}>
              {busy === "reject" && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Send
            </Button>
          </div>
        )}
        {expanded && item.commentCount !== null && (
          <StreamReplies item={item} onOpen={onOpen} onCommented={onCommented} />
        )}
      </div>
    </li>
  );
}

/** The document's open threads (the same ones its comment rail shows) and a
 *  composer: a reply goes on the chosen thread, otherwise a new whole-document
 *  thread is started — both through the existing annotations endpoints. */
function StreamReplies({
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
  const people = useMemo(
    () => (roster?.people ?? []).flatMap((p) => (p.email ? [{ email: p.email, name: p.name }] : [])),
    [roster],
  );
  const open = (data?.threads ?? []).filter((t) => t.status === "open");
  const [replyTo, setReplyTo] = useState<string | null | undefined>(undefined);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Reply on the latest open thread unless the reader picks another (or a
  // new thread) — like answering a post.
  const target = replyTo === undefined ? (open[open.length - 1]?.id ?? null) : replyTo;

  const post = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      if (target) await api.replyAnnotation(item.nestId, item.nodeId, target, body);
      else await api.createAnnotation(item.nestId, item.nodeId, { body, anchor: null });
      setText("");
      onCommented();
      await qc.invalidateQueries({ queryKey: keys.nodeAnnotations(item.nestId, item.nodeId) });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't post the reply.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-2 mt-1 space-y-2" data-testid="stream-replies">
      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading replies…</div>
      ) : (
        open.map((t) => (
          <div key={t.id} className={`border-l-2 pl-3 ${target === t.id ? "border-primary/50" : "border-border"}`}>
            {t.anchor?.quote && (
              <div className="mb-0.5 line-clamp-1 text-xs italic text-muted-foreground">“{t.anchor.quote}”</div>
            )}
            {t.comments.map((c) => (
              <div key={c.id} className="py-0.5 text-sm">
                <span className="text-xs font-medium">{displayNameFor(c.author, people)}</span>{" "}
                <span className="text-xs text-muted-foreground" title={formatServerDate(c.createdAt, SHORT_DATE_TIME)}>
                  {compactTime(c.createdAt)}
                </span>
                <CommentBody body={c.body} members={members} className="text-sm" />
              </div>
            ))}
            <div className="flex gap-3 text-xs">
              <button
                type="button"
                className={target === t.id ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}
                onClick={() => setReplyTo(t.id)}
              >
                {target === t.id ? "Replying here" : "Reply here"}
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => onOpen(item, t.id)}
              >
                Open thread
              </button>
            </div>
          </div>
        ))
      )}
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <MentionTextarea
            formatting
            members={members}
            value={text}
            onValueChange={setText}
            placeholder={target ? "Reply, @ to mention" : "Start a thread, @ to mention"}
            rows={1}
            className="min-h-9 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
            data-testid="stream-composer"
          />
        </div>
        <Button size="sm" className="h-9 shrink-0" disabled={busy || !text.trim()} onClick={() => void post()}>
          {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          {target ? "Reply" : "Post"}
        </Button>
      </div>
      {target && (
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setReplyTo(null)}>
          Start a new thread instead
        </button>
      )}
    </div>
  );
}
