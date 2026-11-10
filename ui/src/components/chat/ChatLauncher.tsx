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
import { ArrowLeft, Check, ChevronDown, Expand, Hash, MessagesSquare, PanelRightClose } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useAuth } from "../../auth/AuthContext";
import type { ChannelPost } from "../../lib/api";
import { channelThreadLink } from "../../lib/channel-deep-link";
import { initialChannel, mentionNotice } from "../../lib/channels";
import { launcherPlacement, launcherShown } from "../../lib/chat-layout";
import { orderByActivity, unreadElsewhere } from "../../lib/chat-sidebar";
import { copyTextWithToast } from "../../lib/clipboard";
import { pushesContent } from "../../lib/hootie-panel";
import { reads } from "../../lib/queries";
import { useSidePanel } from "../../lib/side-panel";
import { ChannelNavProvider } from "./channel-nav";
import { UnreadBadge } from "./ChatSidebar";
import { Conversation } from "./Conversation";
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
  const member = (meta.data as { member?: boolean } | undefined)?.member;
  const [open, setOpen] = useSidePanel("chat");
  const shown = launcherShown({ streamOn: agentStreamEnabled, member, onChatPage: p.onChatPage });
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
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-background text-primary">
            <MessagesSquare className="h-4 w-4" aria-hidden />
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

  const notify = (m: Parameters<typeof mentionNotice>[0]) => {
    const note = mentionNotice(m);
    if (note) toast.warning(note);
  };
  const openPost = timeline.state?.posts.find((x) => x.id === thread) ?? data.thread.data?.post ?? null;
  const copyLink = (post: ChannelPost, messageId?: string) =>
    void copyTextWithToast(`${window.location.origin}${channelThreadLink(p.nestId, channel?.name ?? selected ?? "", post.id, messageId)}`, "Link copied");
  const ordered = orderByActivity(list.live);

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
                <Hash className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{channel?.name ?? selected ?? "Choose a channel"}</span>
                <UnreadBadge count={unreadElsewhere(list.live, selected)} />
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
                  <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className={cn("truncate", c.unread > 0 && "font-semibold")}>{c.name}</span>
                  {c.name === selected ? <Check className="ml-auto h-3.5 w-3.5" aria-label="Open" /> : <UnreadBadge count={c.unread} className="ml-auto" />}
                </DropdownMenuItem>
              ))}
              {ordered.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No channels yet.</p>}
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
            <ErrorState title={`Couldn't load #${selected}`} detail={timeline.error} onRetry={timeline.retry} className="m-4" />
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
            />
          )}
        </div>
      </aside>
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

