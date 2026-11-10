/**
 * The open thread (PO-1200, AC-C3-05): its post, the replies grouped the way
 * the conversation is, and the reply box. The context rail — the nodes this
 * thread touches, from the messages' cards and what it was promoted to —
 * sits at the top of the pane, or in its own column on a wide screen (the
 * page decides; `ContextRail` is one component in both places).
 */
import { useMemo, type ReactNode } from "react";
import { CornerUpRight, FileText, Lightbulb, Link2, ListChecks, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentHandle, ChannelMessage, ChannelPost, ChannelSummary } from "../../lib/api";
import { buildConversation, dateLabel } from "../../lib/chat-grouping";
import { parseServerDate } from "../../lib/dates";
import { threadNodes, type ContextNode } from "../../lib/chat-sidebar";
import type { MentionMember } from "../MarkdownEditor/picker-match";
import { ChatComposer, MENTION_EXTRAS, PostRefusal } from "./ChatComposer";
import { MessageRow, messageActions, type MessageAction, type MessageRowProps } from "./MessageRow";
import { ErrorState, ThreadSkeleton } from "./States";
import type { ThreadState } from "./useChannels";

const VIA_ICON = { link: FileText, decision: Lightbulb, task: ListChecks } as const;
const VIA_LABEL = { link: "Linked", decision: "Decision", task: "Task" } as const;

export function ContextRail({
  nodes,
  canPromote,
  onOpenNode,
  onPromote,
  className,
}: {
  nodes: ContextNode[];
  canPromote: boolean;
  onOpenNode: (nodeId: string) => void;
  onPromote: () => void;
  className?: string;
}) {
  if (nodes.length === 0 && !canPromote) return null;
  return (
    <section className={cn("px-4 py-3", className)} aria-label="In this thread" data-testid="context-rail">
      <div className="flex h-6 items-center justify-between">
        <h3 className="text-xs font-semibold text-muted-foreground">In this thread</h3>
        {canPromote && (
          <button
            type="button"
            onClick={onPromote}
            className="inline-flex items-center gap-1 rounded-md px-1.5 text-xs font-medium text-primary hover:bg-muted"
            data-testid="rail-promote"
          >
            <CornerUpRight className="h-3.5 w-3.5" aria-hidden /> Promote
          </button>
        )}
      </div>
      {nodes.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">No documents linked yet. Promote turns this thread into a decision or a task.</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {nodes.map((n) => {
            const Icon = VIA_ICON[n.via];
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onOpenNode(n.id)}
                  className="group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted"
                  title={`Open ${n.title}`}
                  data-testid="rail-node"
                >
                  <Icon className={cn("h-3.5 w-3.5 shrink-0", n.via === "decision" ? "text-amber-600" : n.via === "task" ? "text-primary" : "text-muted-foreground")} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{n.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{VIA_LABEL[n.via]}</span>
                  <span className="shrink-0 text-xs font-medium text-primary opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">Open</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export interface ThreadPaneProps {
  nestId: string;
  channel: ChannelSummary;
  /** The post the thread hangs off: from the timeline, or the thread read. */
  post: ChannelPost | null;
  thread: { data: ThreadState | null; loading: boolean; error: string | null; retry: () => void };
  canManage: boolean;
  people: MentionMember[];
  agents: AgentHandle[];
  draft: string;
  onDraft: (next: string) => void;
  onReply: (post: ChannelPost, body: string) => Promise<void>;
  onSetResolved: (post: ChannelPost, resolved: boolean) => void;
  onPromote: (post: ChannelPost) => void;
  onCopyLink: (post: ChannelPost, messageId?: string) => void;
  onOpenNode: (nodeId: string) => void;
  onClose: () => void;
  /** The message a permalink named: scrolled to and flashed. */
  highlightMessage?: string | null;
  /** Where the rail goes: here, or the page draws it in its own column. */
  rail: "folded" | "column";
  /** Rendered in the header's left: a Back control in the slide-over. */
  leading?: ReactNode;
  /** The post's and the replies' extra actions (C1: react, edit, delete…). */
  extraActions?: (m: ChannelMessage | ChannelPost, isPost: boolean) => MessageAction[];
  /** Rendered under a message's body (C1: reactions). */
  renderUnder?: (m: ChannelMessage | ChannelPost) => ReactNode;
  /** Per-row state the page owns (C1: editing in place). */
  rowProps?: (m: ChannelMessage | ChannelPost) => Partial<MessageRowProps>;
  className?: string;
}

export function ThreadPane(p: ThreadPaneProps) {
  const post = p.thread.data?.post ?? p.post;
  const replies = p.thread.data?.replies ?? [];
  const nodes = useMemo(() => threadNodes(post, replies, p.nestId), [post, replies, p.nestId]);
  // Replies on the post's own day need no date line: the post is the day.
  const rows = useMemo(() => {
    const postDay = post ? parseServerDate(post.created_at) : null;
    const postLabel = postDay ? dateLabel(postDay) : null;
    return buildConversation(replies).filter((r) => r.kind !== "date" || r.label !== postLabel);
  }, [replies, post]);
  const resolved = post?.status === "resolved";
  const canPromote = p.canManage && !p.channel.archived && !!post;

  return (
    <section className={cn("flex h-full min-h-0 flex-col bg-background", p.className)} aria-label="Thread" data-testid="chat-thread">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        {p.leading}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="truncate text-sm font-semibold leading-5">Thread</h2>
          <p className="truncate text-xs leading-4 text-muted-foreground">{p.channel.title}</p>
        </div>
        <button
          type="button"
          onClick={p.onClose}
          aria-label="Close thread"
          title="Close thread (Esc)"
          data-testid="thread-close"
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>

      {p.rail === "folded" && post && (
        <ContextRail nodes={nodes} canPromote={canPromote} onOpenNode={p.onOpenNode} onPromote={() => p.onPromote(post)} className="border-b" />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {p.thread.error ? (
          <ErrorState title="Couldn't load this thread" detail={p.thread.error} onRetry={p.thread.retry} className="m-4" />
        ) : !post ? (
          <ThreadSkeleton />
        ) : (
          <>
            <MessageRow
              message={post}
              first
              last
              pinnedActions
              testId="thread-post"
              highlight={p.highlightMessage === post.id || p.highlightMessage === (post as { message_id?: string }).message_id}
              onOpenNode={p.onOpenNode}
              {...(p.rowProps?.(post) ?? {})}
              actions={[
                ...messageActions({
                  canPost: p.channel.can_post,
                  canManage: p.canManage,
                  archived: p.channel.archived,
                  post,
                  onPromote: () => p.onPromote(post),
                  onCopyLink: () => p.onCopyLink(post),
                  onSetResolved: (to) => p.onSetResolved(post, to),
                }),
                ...(p.extraActions?.(post, true) ?? []),
              ]}
            >
              {p.renderUnder?.(post)}
            </MessageRow>
            {replies.length > 0 && (
              <div className="mx-4 mt-3 flex items-center gap-3 text-xs text-muted-foreground" role="separator">
                <span>{replies.length === 1 ? "1 reply" : `${replies.length} replies`}</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            {p.thread.loading && replies.length === 0 && post.reply_count > 0 ? (
              <ThreadSkeleton />
            ) : (
              <div className="pt-1" data-testid="thread-replies">
                {rows.map((row) =>
                  row.kind === "date" ? (
                    <div key={row.key} className="mx-4 mt-3 flex items-center gap-3 text-xs text-muted-foreground" role="separator" aria-label={row.label}>
                      <span className="h-px flex-1 bg-border" />
                      <span>{row.label}</span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  ) : row.kind === "message" ? (
                    <MessageRow
                      key={row.key}
                      message={row.message}
                      first={row.first}
                      last={row.last}
                      testId="chat-reply"
                      highlight={p.highlightMessage === row.message.id}
                      onOpenNode={p.onOpenNode}
                      {...(p.rowProps?.(row.message) ?? {})}
                      actions={[
                        { id: "link", label: "Copy link", icon: Link2, onSelect: () => p.onCopyLink(post, row.message.id) },
                        ...(p.extraActions?.(row.message, false) ?? []),
                      ]}
                    >
                      {p.renderUnder?.(row.message)}
                    </MessageRow>
                  ) : null,
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 border-t px-3 py-3">
        {post && p.channel.can_post ? (
          <ChatComposer
            compact
            value={p.draft}
            onChange={p.onDraft}
            onSend={(body) => p.onReply(post, body)}
            people={p.people}
            agents={p.agents}
            extras={MENTION_EXTRAS}
            placeholder={resolved ? "Reply (reopens this thread)…" : "Reply…"}
            ariaLabel="Reply"
          />
        ) : (
          <PostRefusal channel={p.channel} />
        )}
      </div>
    </section>
  );
}
