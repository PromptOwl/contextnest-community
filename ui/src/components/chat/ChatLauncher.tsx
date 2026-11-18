/**
 * The chat on every nest page (PO-1200, AC-C3-07): a slim tab on the right
 * edge, like Hootie's and stacked under it when both show, that opens the
 * chat as a slide-over — the channel switcher at the top, the conversation,
 * the composer, and "Open full page". One side panel is open at a time
 * (lib/side-panel.ts). Shown only when the switch is on and the caller is a
 * person added to the nest, never on the chat page itself.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, ChevronDown, Expand, Hash, Lock, MessagesSquare, PanelRightClose, Users } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuth } from "../../auth/AuthContext";
import type { ChannelPost } from "../../lib/api";
import { channelThreadLink } from "../../lib/channel-deep-link";
import { initialChannel } from "../../lib/channels";
import { chatOn, dmPeer, orderConversations } from "../../lib/chat-harness";
import { launcherPlacement, launcherShown } from "../../lib/chat-layout";
import { unreadForNest } from "../../lib/chat-live";
import { orderByActivity, unreadElsewhere } from "../../lib/chat-sidebar";
import { copyTextWithToast } from "../../lib/clipboard";
import { pushesContent } from "../../lib/hootie-panel";
import { reads } from "../../lib/queries";
import { useSidePanel } from "../../lib/side-panel";
import { ChannelNavProvider } from "./channel-nav";
import { UnreadBadge } from "./ChatSidebar";
import { MemberAvatar } from "./Presence";
import { Conversation } from "./Conversation";
import { noticeMentions, useMessageExtras } from "./MessageExtras";
import { PromoteDialog } from "./PromoteDialog";
import { ConversationSkeleton, EmptyState, ErrorState } from "./States";
import { ThreadPane } from "./ThreadPane";
import { useChannels } from "./useChannels";

const SLIDE_OVER_WIDTH = 480;

export interface ChatLauncherProps {
  nestId: string;
  nestName: string;
  /** The chat page is on screen: no launcher there. */
  onChatPage: boolean;
  /** "Open full page": the chat page at this channel and thread. */
  onOpenFull: (channel: string | null, thread: string | null) => void;
  onOpenNode: (nodeId: string) => void;
}

export function ChatLauncher(p: ChatLauncherProps) {
  const { agentStreamEnabled, hootieEnabled, runnerKeyConfigured, isAdmin } = useAuth();
  const meta = useQuery({ ...reads.nest(p.nestId), enabled: agentStreamEnabled && !p.onChatPage });
  // The nest's own answer (`chat`, C2): switch, the nest's setting, membership.
  const on = chatOn(meta.data as { chat?: boolean; member?: boolean } | undefined, agentStreamEnabled);
  const [open, setOpen] = useSidePanel("chat");
  const shown = launcherShown({ streamOn: agentStreamEnabled, member: on, onChatPage: p.onChatPage });
  // App-wide unread (C2): this nest's share, on the tab. Polled while the tab
  // is visible; nothing moves on a timer, the number just changes.
  const unread = useQuery({ ...reads.chatUnread(), enabled: shown && !open, refetchInterval: 60_000, refetchIntervalInBackground: false, retry: false });
  const waiting = unreadForNest(unread.data, p.nestId);
  // Hootie's own rule for showing its tab (HootiePanel.tsx).
  const hootieShown = hootieEnabled && (runnerKeyConfigured || isAdmin);
  const placement = launcherPlacement(hootieShown);

  // Leaving for the chat page, or losing the gate, closes the slide-over.
  useEffect(() => {
    if (!shown && open) setOpen(false);
  }, [shown, open, setOpen]);

  if (!shown) return null;
  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open chat"
          title="Chat"
          data-testid="chat-launcher"
          data-placement={placement}
          className={cn(
            "fixed right-0 z-40 flex flex-col items-center gap-2 rounded-l-xl bg-primary py-3 pl-1.5 pr-1 text-primary-foreground shadow-lg transition-all hover:pl-2.5 focus:outline-none focus-visible:ring-4 focus-visible:ring-primary/30",
            placement === "centre" ? "top-1/2 -translate-y-1/2" : "top-[calc(50%+4.5rem)]",
          )}
        >
          <span className="relative flex h-8 w-8 items-center justify-center rounded-full bg-background text-primary">
            <MessagesSquare className="h-4 w-4" aria-hidden />
            {waiting > 0 && (
              <span className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-background px-1 text-center text-[10px] font-semibold leading-4 text-primary ring-1 ring-primary" aria-label={`${waiting} unread`} data-testid="chat-launcher-unread">
                {waiting > 99 ? "99+" : waiting}
              </span>
            )}
          </span>
          <span className="text-xs font-medium [writing-mode:vertical-rl]">Chat</span>
        </button>
      )}
      {open && <ChatSlideOver nestId={p.nestId} nestName={p.nestName} onClose={() => setOpen(false)} onOpenFull={p.onOpenFull} onOpenNode={p.onOpenNode} />}
    </>
  );
}

const fail = (fallback: string) => (e: unknown) => {
  toast.error((e as Error | undefined)?.message || fallback);
};

export function ChatSlideOver(p: { nestId: string; nestName: string; onClose: () => void; onOpenFull: ChatLauncherProps["onOpenFull"]; onOpenNode: (nodeId: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<string | null>(null);
  const data = useChannels(p.nestId, selected, thread);
  const { list, channel, timeline, actions } = data;
  const { adminStatus } = useAuth();
  const me = adminStatus?.me?.email ?? null;
  const [draft, setDraft] = useState("");
  const [replyDraft, setReplyDraft] = useState("");
  const [promoting, setPromoting] = useState<ChannelPost | null>(null);
  const openNode = useRef(p.onOpenNode);
  openNode.current = p.onOpenNode;
  const nav = useMemo(() => ({ nestId: p.nestId, openNode: (id: string) => openNode.current(id) }), [p.nestId]);

  useEffect(() => {
    if (selected || !list.data) return;
    setSelected(initialChannel(null, list.data));
  }, [selected, list.data]);

  // Beside the page on a wide screen, over it on a narrow one — Hootie's rule.
  const [viewport, setViewport] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    const on = () => setViewport(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const push = pushesContent(viewport);
  useEffect(() => {
    const root = document.documentElement;
    if (push) root.style.setProperty("--hootie-inset", `${SLIDE_OVER_WIDTH}px`);
    else root.style.removeProperty("--hootie-inset");
    return () => {
      root.style.removeProperty("--hootie-inset");
    };
  }, [push]);

  // Escape closes the thread first, then the slide-over.
  const onCloseRef = useRef(p.onClose);
  onCloseRef.current = p.onClose;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("[role=dialog]") || t.closest("[role=menu]") || t.closest("[role=listbox]"))) return;
      if (thread) setThread(null);
      else onCloseRef.current();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [thread]);

  const notify = noticeMentions;
  const meta = useQuery(reads.nest(p.nestId));
  const extras = useMessageExtras({ channel, actions, permission: (meta.data as { permission?: string } | undefined)?.permission ?? null });
  const openPost = timeline.state?.posts.find((x) => x.id === thread) ?? data.thread.data?.post ?? null;
  const copyLink = (post: ChannelPost, messageId?: string) =>
    void copyTextWithToast(`${window.location.origin}${channelThreadLink(p.nestId, channel?.name ?? selected ?? "", post.id, messageId)}`, "Link copied");
  const ordered = orderByActivity(list.live);
  const dms = orderConversations(data.conversations.rows);
  const conv = channel?.conversation ?? null;
  const allRows = [...list.live, ...data.conversations.rows];

  return (
    <ChannelNavProvider value={nav}>
      <aside
        role="complementary"
        aria-label="Chat"
        data-testid="chat-slide-over"
        data-pushes={push ? "true" : "false"}
        style={{ width: push ? SLIDE_OVER_WIDTH : undefined }}
        className={cn("fixed inset-y-0 right-0 z-40 flex max-w-full flex-col border-l bg-background shadow-2xl animate-in slide-in-from-right duration-200 motion-reduce:animate-none", !push && "w-full sm:w-[480px]")}
      >
        <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
          {thread ? (
            <button type="button" onClick={() => setThread(null)} aria-label="Back to the channel" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <ArrowLeft className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-sm font-semibold hover:bg-muted" aria-label="Switch channel" data-testid="slide-over-switcher">
                {conv ? (
                  <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : channel?.private ? (
                  <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <Hash className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="truncate">{conv ? channel?.title : (channel?.name ?? selected ?? "Choose a channel")}</span>
                <UnreadBadge count={unreadElsewhere(allRows, selected)} />
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[60vh] w-64 overflow-y-auto">
              <DropdownMenuLabel>{p.nestName}</DropdownMenuLabel>
              {ordered.map((c) => (
                <DropdownMenuItem
                  key={c.id}
                  onSelect={() => {
                    setSelected(c.name);
                    setThread(null);
                  }}
                  className="h-9 gap-2"
                >
                  {c.private ? <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                  <span className={cn("truncate", c.unread > 0 && "font-semibold")}>{c.name}</span>
                  {c.name === selected ? <Check className="ml-auto h-3.5 w-3.5" aria-label="Open" /> : <UnreadBadge count={c.unread} className="ml-auto" />}
                </DropdownMenuItem>
              ))}
              {ordered.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No channels yet.</p>}
              {dms.length > 0 && <DropdownMenuLabel className="mt-1 text-xs font-semibold text-muted-foreground">Direct messages</DropdownMenuLabel>}
              {dms.map((c) => {
                const peer = c.conversation ? dmPeer(c.conversation, me) : null;
                return (
                  <DropdownMenuItem
                    key={c.id}
                    onSelect={() => {
                      setSelected(c.name);
                      setThread(null);
                    }}
                    className="h-9 gap-2"
                    data-testid="slide-over-dm"
                  >
                    {peer ? (
                      <MemberAvatar kind={peer.kind} label={peer.kind === "agent" ? peer.handle : peer.name || peer.email} online={peer.kind === "person" ? data.live.online.has(peer.email.toLowerCase()) : undefined} size="sm" />
                    ) : (
                      <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span className={cn("truncate", c.unread > 0 && "font-semibold")}>{c.title}</span>
                    {c.name === selected ? <Check className="ml-auto h-3.5 w-3.5" aria-label="Open" /> : <UnreadBadge count={c.unread} className="ml-auto" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={() => p.onOpenFull(selected, thread)}
            aria-label="Open full page"
            title="Open full page"
            data-testid="slide-over-full"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Expand className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={p.onClose}
            aria-label="Close chat"
            title="Close chat (Esc)"
            data-testid="chat-close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <PanelRightClose className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1">
          {list.error ? (
            <ErrorState title="Couldn't load channels" detail={list.error} onRetry={list.retry} className="m-4" />
          ) : list.data && list.live.length === 0 ? (
            <EmptyState icon={Hash} title="No channels yet" hint="Open the full page to create the first one." className="h-full" />
          ) : timeline.error ? (
            <ErrorState title={conv ? "Couldn't load this conversation" : `Couldn't load #${selected}`} detail={timeline.error} onRetry={timeline.retry} className="m-4" />
          ) : !channel || !timeline.state ? (
            <ConversationSkeleton compact />
          ) : thread ? (
            <ThreadPane
              nestId={p.nestId}
              channel={channel}
              post={openPost}
              thread={data.thread}
              canManage={list.canManage}
              people={data.roster.people}
              agents={data.roster.agents}
              draft={replyDraft}
              onDraft={setReplyDraft}
              onReply={async (post, body) => {
                try {
                  notify(await actions.reply(post, body));
                } catch (e) {
                  fail("Could not post the reply")(e);
                  throw e;
                }
              }}
              onSetResolved={(post, to) => void actions.setResolved(post.id, to).catch(fail("Could not update the thread"))}
              onPromote={setPromoting}
              onCopyLink={copyLink}
              onOpenNode={p.onOpenNode}
              onClose={() => setThread(null)}
              rail="folded"
              extraActions={extras.extraActions}
              renderUnder={extras.renderUnder}
              rowProps={extras.rowProps}
            />
          ) : (
            <Conversation
              key={channel.name}
              compact
              channel={channel}
              state={timeline.state}
              me={me}
              unreadAtOpen={0}
              canManage={false}
              people={data.roster.people}
              agents={data.roster.agents}
              openThread={null}
              highlightThread={null}
              draft={draft}
              onDraft={setDraft}
              onPost={async (body) => {
                try {
                  notify(await actions.post(body));
                } catch (e) {
                  fail("Could not post the message")(e);
                  throw e;
                }
              }}
              onOpenThread={(post) => setThread(post.id)}
              onSetResolved={(post, to) => void actions.setResolved(post.id, to).catch(fail("Could not update the thread"))}
              onPromote={setPromoting}
              onCopyLink={(post) => copyLink(post)}
              onLoadMore={() => actions.loadMore().catch(fail("Could not load older posts"))}
              onOpenNode={p.onOpenNode}
              lag={list.lag}
              typingLine={data.live.typingLine}
              onType={data.live.onType}
              online={data.live.online}
              extraActions={extras.extraActions}
              renderUnder={extras.renderUnder}
              rowProps={extras.rowProps}
            />
          )}
        </div>
      </aside>
      {extras.dialogs}
      <PromoteDialog
        post={promoting}
        onClose={() => setPromoting(null)}
        onPromote={async (post, input) => {
          const r = await actions.promote(post.id, { kind: input.kind, title: input.title, ...(input.summary ? { summary: input.summary } : {}) });
          const open = { label: "Open", onClick: () => p.onOpenNode(r.node.id) };
          if (r.existing) toast.info(`This thread is already a ${input.kind}: ${r.node.title}`, { action: open });
          else toast.success(`Promoted to a ${input.kind}: ${r.node.title}`, { action: open });
        }}
      />
    </ChannelNavProvider>
  );
}

