/**
 * One post in the timeline: the message, its markers (resolved, promoted),
 * its actions, and, when open, its thread with the reply box. On a phone the
 * secondary actions fold into one menu; Reply stays a button.
 */
import { useEffect, useRef } from "react";
import { CheckCircle2, CornerUpRight, Lightbulb, Link2, ListChecks, MessageSquare, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OverflowMenu, type OverflowAction } from "@/components/ui/overflow-menu";
import { cn } from "@/lib/utils";
import type { AgentHandle, ChannelPost, ChannelSummary } from "../../lib/api";
import { replyLabel } from "../../lib/channels";
import type { MentionMember } from "../MarkdownEditor/picker-match";
import { Composer, PostRefusal } from "./Composer";
import { MessageView } from "./MessageView";
import { ErrorState, LoadingState } from "./StateBlocks";
import type { ThreadState } from "./useChannels";

export interface PostItemProps {
  post: ChannelPost;
  channel: ChannelSummary;
  /** May promote (the nest's writers). */
  canManage: boolean;
  open: boolean;
  /** Arrived here by a link: scroll to the post and flash it once. */
  highlight: boolean;
  thread: { data: ThreadState | null; loading: boolean; error: string | null; retry: () => void };
  people: MentionMember[];
  agents: AgentHandle[];
  replyDraft: string;
  onReplyDraft: (next: string) => void;
  onToggle: () => void;
  onReply: (body: string) => Promise<void>;
  onSetResolved: (resolved: boolean) => void;
  onPromote: () => void;
  onCopyLink: () => void;
  onOpenNode: (nodeId: string) => void;
}

const QUIET = "h-8 gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground";

export function PostItem(p: PostItemProps) {
  const { post, channel, open } = p;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (p.highlight) ref.current?.scrollIntoView({ block: "center" });
  }, [p.highlight]);

  const resolved = post.status === "resolved";
  const secondary: OverflowAction[] = [
    ...(channel.can_post
      ? [
          resolved
            ? { label: "Reopen", icon: RotateCcw, onSelect: () => p.onSetResolved(false) }
            : { label: "Resolve", icon: CheckCircle2, onSelect: () => p.onSetResolved(true) },
        ]
      : []),
    ...(p.canManage && !channel.archived ? [{ label: "Promote", icon: CornerUpRight, onSelect: p.onPromote }] : []),
    { label: "Copy link", icon: Link2, onSelect: p.onCopyLink },
  ];

  return (
    <li
      ref={ref}
      id={`post-${post.id}`}
      data-testid="channel-post"
      data-thread={post.id}
      className={cn("group py-4", p.highlight && "anchor-flash")}
    >
      <MessageView message={post}>
        {(resolved || (post.promoted?.length ?? 0) > 0) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {resolved && (
              <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400" data-testid="post-resolved">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Resolved
              </span>
            )}
            {post.promoted?.map((n) => (
              <button
                key={`${n.kind}:${n.node_id}`}
                type="button"
                onClick={() => p.onOpenNode(n.node_id)}
                className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-sm font-medium text-primary hover:underline sm:min-h-0"
                title={`Open the ${n.kind} this thread was promoted to`}
                data-testid="post-promoted"
              >
                {n.kind === "decision" ? <Lightbulb className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <ListChecks className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                <span className="truncate">
                  Promoted to {n.kind}: {n.title}
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="-ml-2 mt-1 flex items-center gap-1">
          <Button variant="ghost" size="sm" className={QUIET} onClick={p.onToggle} aria-expanded={open} data-testid="post-thread-toggle">
            <MessageSquare className="h-3.5 w-3.5" aria-hidden />
            {replyLabel(post.reply_count)}
          </Button>
          {/* Wide screens: the actions inline, shown for the post under the
              pointer or holding focus, and always for an open thread or on a
              screen with no pointer to hover with. */}
          <span
            className={cn(
              "hidden items-center gap-1 sm:flex",
              !open && "sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 [@media(hover:none)]:opacity-100",
            )}
          >
            {secondary.map((a) => {
              const Icon = a.icon!;
              return (
                <Button key={a.label} variant="ghost" size="sm" className={QUIET} onClick={a.onSelect}>
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                  {a.label}
                </Button>
              );
            })}
          </span>
          {/* Phone: one menu. */}
          <OverflowMenu actions={secondary} align="start" className="h-8 w-8 text-muted-foreground sm:hidden" triggerTitle="Message actions" />
        </div>

        {open && (
          <div className="mt-2 border-l-2 border-border pl-3" data-testid="post-thread">
            {p.thread.error ? (
              <ErrorState title="Couldn't load this thread" detail={p.thread.error} onRetry={p.thread.retry} />
            ) : p.thread.loading ? (
              post.reply_count > 0 && <LoadingState label="Loading replies…" />
            ) : (
              <ul className="space-y-3 py-1">
                {p.thread.data?.replies.map((r) => (
                  <li key={r.id} data-testid="channel-reply">
                    <MessageView message={r} compact />
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2">
              {channel.can_post ? (
                <Composer
                  value={p.replyDraft}
                  onChange={p.onReplyDraft}
                  onSend={p.onReply}
                  people={p.people}
                  agents={p.agents}
                  placeholder={resolved ? "Reply… replying reopens this thread" : "Reply in thread…"}
                  sendLabel="Reply"
                  ariaLabel="Reply"
                />
              ) : (
                <PostRefusal channel={channel} />
              )}
            </div>
          </div>
        )}
      </MessageView>
    </li>
  );
}
