/**
 * The conversation pane (PO-1200, AC-C3-03, AC-C3-04, AC-C3-09): the
 * channel's header, its posts oldest first in author groups with date lines
 * and the "New" line, "Load older" at the top, a "Jump to latest" pill while
 * scrolled up, and the composer pinned under the list. The list keeps its
 * place: new messages scroll it only when it was already at the end.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, ArrowDown, Hash, Loader2, MessagesSquare, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OverflowMenu } from "@/components/ui/overflow-menu";
import { cn } from "@/lib/utils";
import type { AgentHandle, ChannelPost, ChannelSummary } from "../../lib/api";
import type { TimelineState } from "../../lib/channels";
import { buildConversation, newLineAnchor, sortChronological } from "../../lib/chat-grouping";
import { jumpPill } from "../../lib/chat-layout";
import { relTime } from "../../lib/dates";
import type { MentionMember } from "../MarkdownEditor/picker-match";
import { ChatComposer, PostRefusal } from "./ChatComposer";
import { MessageRow, messageActions, type MessageAction } from "./MessageRow";
import { EmptyState } from "./States";

export interface ConversationProps {
  channel: ChannelSummary;
  state: TimelineState;
  /** The signed-in person, for the "New" line. */
  me: string | null;
  /** Unread when the channel was opened: where the "New" line goes. */
  unreadAtOpen: number;
  canManage: boolean;
  people: MentionMember[];
  agents: AgentHandle[];
  openThread: string | null;
  /** A thread (or message) arrived at by link: scroll to it and flash it. */
  highlightThread: string | null;
  draft: string;
  onDraft: (next: string) => void;
  onPost: (body: string) => Promise<void>;
  onOpenThread: (post: ChannelPost) => void;
  onSetResolved: (post: ChannelPost, resolved: boolean) => void;
  onPromote: (post: ChannelPost) => void;
  onCopyLink: (post: ChannelPost) => void;
  onLoadMore: () => Promise<void>;
  onOpenNode: (nodeId: string) => void;
  onArchive?: () => void;
  onRestore?: () => void;
  /** The list read has failed since it last succeeded (AC-C3-09). */
  lag: { stale: boolean; lastSuccessAt: number | null };
  /** The slide-over: a smaller header, no purpose line. */
  compact?: boolean;
  /** Left of the title: the phone's channel-list button. */
  leading?: ReactNode;
  /** Right of the title, before the channel menu (search, pins when C1 lands). */
  trailing?: ReactNode;
  /** Extra per-post actions (C1: react, edit, delete, pin, save). */
  extraActions?: (post: ChannelPost) => MessageAction[];
  /** Rendered under a post's body (C1: reactions). */
  renderUnder?: (post: ChannelPost) => ReactNode;
}

export function Conversation(p: ConversationProps) {
  const { channel, state } = p;
  const listRef = useRef<HTMLDivElement>(null);
  const [distance, setDistance] = useState(0);
  const [arrived, setArrived] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  // The "New" line is placed once, from the unread count the channel was
  // opened with, and stays put while the person reads.
  const anchor = useMemo(() => newLineAnchor(sortChronological(state.posts), p.unreadAtOpen, p.me), [state.posts, p.unreadAtOpen, p.me]);
  const newBefore = useRef<string | null>(null);
  if (newBefore.current === null && anchor) newBefore.current = anchor;
  const rows = useMemo(() => buildConversation(state.posts, { newBefore: newBefore.current }), [state.posts]);

  const measure = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setDistance(el.scrollHeight - el.scrollTop - el.clientHeight);
  }, []);
  const toEnd = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setArrived(0);
    setDistance(0);
  }, []);

  // First paint: the deep-linked thread, else the "New" line, else the end.
  const settled = useRef(false);
  useLayoutEffect(() => {
    if (settled.current) return;
    settled.current = true;
    const el = listRef.current;
    if (!el) return;
    const target = p.highlightThread
      ? el.querySelector<HTMLElement>(`[data-message="${CSS.escape(p.highlightThread)}"]`)
      : el.querySelector<HTMLElement>('[data-testid="new-line"]');
    if (target) target.scrollIntoView({ block: "center" });
    else el.scrollTop = el.scrollHeight;
    measure();
  }, [p.highlightThread, measure]);

  // Later arrivals: follow when at the end, count when not.
  const count = state.posts.length;
  const lastCount = useRef(count);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const added = count - lastCount.current;
    lastCount.current = count;
    if (added <= 0) return;
    if (atEnd.current) toEnd();
    else setArrived((n) => n + added);
  }, [count, toEnd]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const d = el.scrollHeight - el.scrollTop - el.clientHeight;
    atEnd.current = d <= 80;
    setDistance(d);
    if (atEnd.current) setArrived(0);
  };

  // Load older: keep what is on screen where it is.
  const loadMore = async () => {
    const el = listRef.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    setLoadingMore(true);
    try {
      await p.onLoadMore();
    } finally {
      setLoadingMore(false);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    }
  };

  // A thread opened by link: scroll to it when it is on screen.
  useEffect(() => {
    if (!p.highlightThread || !settled.current) return;
    listRef.current?.querySelector<HTMLElement>(`[data-message="${CSS.escape(p.highlightThread)}"]`)?.scrollIntoView({ block: "center" });
  }, [p.highlightThread]);

  const pill = jumpPill(distance, arrived);

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={channel.title} data-testid="chat-conversation">
      {!p.compact && (
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        {p.leading}
        <div className="flex min-w-0 flex-1 items-baseline gap-2 px-1">
          <h2 className="flex min-w-0 shrink-0 items-center gap-1 truncate text-base font-semibold leading-6">
            <Hash className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{channel.name}</span>
          </h2>
          {channel.archived && <Badge variant="neutral">Archived</Badge>}
          {!p.compact && channel.purpose && (
            <p className="hidden min-w-0 truncate text-sm text-muted-foreground lg:block" title={channel.purpose}>
              {channel.purpose}
            </p>
          )}
        </div>
        {p.trailing}
        {p.canManage &&
          (channel.archived ? (
            p.onRestore && (
              <Button size="sm" variant="outline" onClick={p.onRestore} className="h-8 shrink-0">
                <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" /> Restore
              </Button>
            )
          ) : (
            p.onArchive && (
              <OverflowMenu
                className="h-8 w-8 shrink-0"
                triggerTitle="Channel actions"
                testId="channel-actions"
                actions={[{ label: "Archive channel", icon: Archive, onSelect: p.onArchive, testId: "channel-archive" }]}
              />
            )
          ))}
      </header>
      )}

      {p.lag.stale && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground" role="status" data-testid="chat-lag">
          <WifiOff className="h-3.5 w-3.5" aria-hidden />
          Reconnecting… {p.lag.lastSuccessAt ? `last updated ${relTime(new Date(p.lag.lastSuccessAt).toISOString())}` : "nothing updated yet"}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={listRef} onScroll={onScroll} className="h-full overflow-y-auto pb-3" data-testid="chat-list">
          {state.has_more && (
            <div className="flex items-center justify-center gap-3 px-4 pt-3">
              <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()} data-testid="channel-load-more">
                {loadingMore && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Load older
              </Button>
              <span className="text-xs text-muted-foreground">
                {state.posts.length} of {state.total}
              </span>
            </div>
          )}
          {rows.length === 0 ? (
            <EmptyState
              icon={MessagesSquare}
              title="No messages yet"
              hint={channel.can_post ? "Write the first one below. Type @ to bring in a teammate or an agent." : "Nothing has been posted in this channel."}
              className="h-full"
            />
          ) : (
            rows.map((row) =>
              row.kind === "date" ? (
                <div key={row.key} className="mx-4 mt-4 flex items-center gap-3" role="separator" aria-label={row.label} data-testid="date-line">
                  <span className="h-px flex-1 bg-border" />
                  <span className="rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground">{row.label}</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              ) : row.kind === "new" ? (
                <div key={row.key} className="mx-4 mt-3 flex items-center gap-2" role="separator" aria-label="New messages" data-testid="new-line">
                  <span className="h-px flex-1 bg-primary/70" />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-primary">New</span>
                </div>
              ) : (
                <MessageRow
                  key={row.key}
                  message={row.message}
                  first={row.first}
                  last={row.last}
                  testId="chat-post"
                  highlight={p.highlightThread === row.message.id}
                  threadOpen={p.openThread === row.message.id}
                  pinnedActions={p.openThread === row.message.id}
                  onOpenThread={() => p.onOpenThread(row.message)}
                  onOpenNode={p.onOpenNode}
                  actions={[
                    ...messageActions({
                      canPost: channel.can_post,
                      canManage: p.canManage,
                      archived: channel.archived,
                      post: row.message,
                      onReply: () => p.onOpenThread(row.message),
                      onPromote: () => p.onPromote(row.message),
                      onCopyLink: () => p.onCopyLink(row.message),
                      onSetResolved: (to) => p.onSetResolved(row.message, to),
                    }),
                    ...(p.extraActions?.(row.message) ?? []),
                  ]}
                >
                  {p.renderUnder?.(row.message)}
                </MessageRow>
              ),
            )
          )}
        </div>
        {pill.shown && (
          <button
            type="button"
            onClick={toEnd}
            className="absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background px-3 text-xs font-medium shadow-md animate-in fade-in-0 duration-150 hover:bg-muted motion-reduce:animate-none"
            data-testid="jump-latest"
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
            {pill.label}
          </button>
        )}
      </div>

      <div className={cn("shrink-0 px-4 pb-3", p.compact ? "pt-2" : "pt-1")}>
        {channel.can_post ? (
          <ChatComposer
            key={channel.name}
            compact={p.compact}
            value={p.draft}
            onChange={p.onDraft}
            onSend={p.onPost}
            people={p.people}
            agents={p.agents}
            placeholder={`Message ${channel.title}`}
            ariaLabel={`Message ${channel.title}`}
          />
        ) : (
          <PostRefusal channel={channel} />
        )}
      </div>
    </section>
  );
}

