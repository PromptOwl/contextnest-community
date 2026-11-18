/**
 * One message in a conversation or a thread (PO-1200, AC-C3-03, AC-C3-04).
 * The first message of a group carries the avatar, the name and the time;
 * the rest show the body alone, with the time in the gutter under the
 * pointer. Actions sit in a small toolbar at the message's top-right, shown
 * for the message under the pointer or holding focus, floating just above
 * it so it never covers the name or the text; on a touch screen one menu per message takes their place.
 * A post also carries its thread summary and its markers (resolved,
 * promoted).
 */
import { forwardRef, useState, type ReactNode } from "react";
import { CheckCircle2, CornerUpRight, Lightbulb, Link2, ListChecks, MessageSquare, Pin, RotateCcw, Trash2, type LucideIcon } from "lucide-react";
import { OverflowMenu, type OverflowAction } from "@/components/ui/overflow-menu";
import { cn } from "@/lib/utils";
import type { ChannelMessage, ChannelPost } from "../../lib/api";
import { authorOf } from "../../lib/channels";
import { threadSummary, timeLabel } from "../../lib/chat-grouping";
import { tombstoneLine } from "../../lib/chat-messages";
import { formatServerDate, relTime } from "../../lib/dates";
import { ArtifactCards } from "../ArtifactCards";
import { Avatar, MessageBody } from "./MessageBody";

export interface MessageAction {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  destructive?: boolean;
  /** Drawn pressed (a reaction of mine, a saved message). */
  active?: boolean;
}

export interface MessageRowProps {
  message: ChannelMessage | ChannelPost;
  /** Heads its group: avatar, name and time. */
  first: boolean;
  /** Closes its group: a little more room below. */
  last?: boolean;
  /** The actions offered, in order; empty hides the toolbar. */
  actions?: MessageAction[];
  /** Keep the toolbar visible (the open thread's post). */
  pinnedActions?: boolean;
  /** Arrived here by a link: flash once. */
  highlight?: boolean;
  /** A post: its thread summary opens the thread. */
  onOpenThread?: () => void;
  threadOpen?: boolean;
  onOpenNode?: (nodeId: string) => void;
  /** Rendered under the body (reactions, cards the caller adds). */
  children?: ReactNode;
  /** C1: the body is being edited in place. */
  editing?: boolean;
  onSaveEdit?: (body: string) => Promise<void>;
  onCancelEdit?: () => void;
  className?: string;
  testId?: string;
}

const isPost = (m: ChannelMessage | ChannelPost): m is ChannelPost => "status" in m && "reply_count" in m;

export const MessageRow = forwardRef<HTMLDivElement, MessageRowProps>(function MessageRow(
  { message, first, last, actions = [], pinnedActions, highlight, onOpenThread, threadOpen, onOpenNode, children, editing, onSaveEdit, onCancelEdit, className, testId },
  ref,
) {
  const deleted = message.deleted === true;
  const who = authorOf(message);
  const post = isPost(message) ? message : null;
  const resolved = post?.status === "resolved";
  const summary = post ? threadSummary(post, post.last_reply_at ? relTime(post.last_reply_at) : null) : null;
  const menu: OverflowAction[] = actions.map((a) => ({ label: a.label, icon: a.icon, onSelect: a.onSelect, destructive: a.destructive }));
  const time = timeLabel(message.created_at);
  const full = formatServerDate(message.created_at) || message.created_at;

  return (
    <div
      ref={ref}
      id={`message-${message.id}`}
      data-testid={testId ?? "chat-message"}
      data-message={message.id}
      tabIndex={-1}
      className={cn(
        "group relative flex gap-3 rounded-md px-4 py-0.5 outline-none hover:bg-muted/40 focus-visible:bg-muted/40",
        first ? "mt-3" : "mt-0",
        last && "mb-0.5",
        highlight && "anchor-flash",
        className,
      )}
    >
      {first ? (
        <Avatar message={message} />
      ) : (
        <span className="flex w-8 shrink-0 items-start justify-end pt-0.5 text-[11px] leading-5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden>
          {time}
        </span>
      )}
      <div className="min-w-0 flex-1">
        {first && (
          <div className="flex flex-wrap items-baseline gap-x-2 leading-5">
            <span className="text-sm font-semibold text-foreground" title={who.agent ? undefined : message.author}>
              {who.name}
            </span>
            {who.onBehalfOf && (
              <span className="text-xs text-muted-foreground" title={message.author}>
                agent, for {who.onBehalfOf}
              </span>
            )}
            <time className="text-xs text-muted-foreground" dateTime={message.created_at} title={full}>
              {time}
            </time>
          </div>
        )}
        {!first && <span className="sr-only">{`${who.name}, ${full}`}</span>}
        {deleted ? (
          <p className="text-sm italic text-muted-foreground" data-testid="tombstone">
            {tombstoneLine(message)}
          </p>
        ) : editing && onSaveEdit ? (
          <InlineEdit initial={message.body} onSave={onSaveEdit} onCancel={onCancelEdit} />
        ) : (
          <>
            <MessageBody body={message.body} mentions={message.mentions} cards={message.cards} />
            {message.edited_at && (
              <span className="text-[11px] text-muted-foreground" title={formatServerDate(message.edited_at) || undefined} data-testid="edited">
                (edited)
              </span>
            )}
            {message.pinned && (
              <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="pinned-mark">
                <Pin className="h-3 w-3" aria-hidden /> Pinned
              </span>
            )}
          </>
        )}
        {!deleted && <ArtifactCards cards={message.cards} />}
        {!deleted && children}
        {post && (resolved || (post.promoted?.length ?? 0) > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {resolved && (
              <span className="inline-flex items-center gap-1 font-medium text-emerald-700" data-testid="post-resolved">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Resolved
              </span>
            )}
            {post.promoted?.map((n) => (
              <button
                key={`${n.kind}:${n.node_id}`}
                type="button"
                onClick={() => onOpenNode?.(n.node_id)}
                className="inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 font-medium text-foreground hover:bg-muted"
                title={`Open the ${n.kind} this thread was promoted to`}
                data-testid="post-promoted"
              >
                {n.kind === "decision" ? <Lightbulb className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden /> : <ListChecks className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />}
                <span className="capitalize">{n.kind}</span>
                <span className="truncate font-normal text-muted-foreground">{n.title}</span>
              </button>
            ))}
          </div>
        )}
        {post && summary && onOpenThread && (
          <button
            type="button"
            onClick={onOpenThread}
            aria-expanded={threadOpen}
            className={cn(
              "mt-1 inline-flex items-center gap-1.5 rounded-md py-0.5 pr-2 text-xs font-medium text-primary hover:underline",
              threadOpen && "underline",
            )}
            data-testid="post-thread-toggle"
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden />
            {summary}
          </button>
        )}
      </div>

      {actions.length > 0 && !deleted && !editing && (
        <>
          {/* Wide screens: the toolbar for the message under the pointer or holding focus. */}
          <div
            className={cn(
              "absolute -top-4 right-3 z-10 hidden items-center gap-0.5 rounded-md border bg-background p-0.5 shadow-sm sm:flex",
              !pinnedActions && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:hidden",
            )}
            role="toolbar"
            aria-label="Message actions"
            data-testid="message-actions"
          >
            {actions.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={a.onSelect}
                title={a.label}
                aria-label={a.label}
                aria-pressed={a.active}
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  a.active && "bg-muted text-foreground",
                  a.destructive && "hover:text-destructive",
                )}
                data-action={a.id}
              >
                <a.icon className="h-3.5 w-3.5" aria-hidden />
              </button>
            ))}
          </div>
          {/* Touch screens: one menu. */}
          <OverflowMenu actions={menu} align="end" className="h-7 w-7 shrink-0 self-start text-muted-foreground sm:hidden [@media(hover:none)]:sm:flex" triggerTitle="Message actions" />
        </>
      )}
    </div>
  );
});

/** Editing a message where it stands: Enter saves, Escape cancels. */
function InlineEdit({ initial, onSave, onCancel }: { initial: string; onSave: (body: string) => Promise<void>; onCancel?: () => void }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await onSave(body);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-0.5" data-testid="message-edit">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel?.();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        aria-label="Edit message"
        className="block w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-sm leading-5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        <button type="button" onClick={() => void save()} disabled={busy || !text.trim()} className="h-7 rounded-md bg-primary px-2.5 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          Save
        </button>
        <button type="button" onClick={onCancel} className="h-7 rounded-md px-2 font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
          Cancel
        </button>
        <span className="text-muted-foreground">Enter saves, Escape cancels.</span>
      </div>
    </div>
  );
}

/** The standard actions of a post or a reply, in the order the toolbar shows them. */
export const DELETE_ICON = Trash2;

export function messageActions(input: {
  canPost: boolean;
  canManage: boolean;
  archived: boolean;
  post: ChannelPost | null;
  onReply?: () => void;
  onPromote?: () => void;
  onCopyLink: () => void;
  onSetResolved?: (resolved: boolean) => void;
}): MessageAction[] {
  const out: MessageAction[] = [];
  if (input.onReply) out.push({ id: "reply", label: "Reply in thread", icon: MessageSquare, onSelect: input.onReply });
  if (input.post && input.canPost && input.onSetResolved) {
    const resolved = input.post.status === "resolved";
    out.push(
      resolved
        ? { id: "reopen", label: "Reopen", icon: RotateCcw, onSelect: () => input.onSetResolved!(false) }
        : { id: "resolve", label: "Resolve", icon: CheckCircle2, onSelect: () => input.onSetResolved!(true) },
    );
  }
  if (input.post && input.canManage && !input.archived && input.onPromote) out.push({ id: "promote", label: "Promote to a decision or task", icon: CornerUpRight, onSelect: input.onPromote });
  out.push({ id: "link", label: "Copy link", icon: Link2, onSelect: input.onCopyLink });
  return out;
}
