/**
 * The team chat harness (PO-1200): the nest's channels beside the open
 * conversation, with the thread beside that. `useChannels` owns the data and
 * the refresh, the URL (through `location`) owns which channel and thread
 * are open, `paneLayout` says where each pane goes at this width, and each
 * part of the screen is its own component in this folder.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hash, PanelLeft } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "../../auth/AuthContext";
import type { ChannelPost, ChannelSummary, MentionItem } from "../../lib/api";
import { channelThreadLink, readChannelDeepLink } from "../../lib/channel-deep-link";
import { initialChannel, mentionNotice } from "../../lib/channels";
import { paneLayout } from "../../lib/chat-layout";
import { mentionsForNest, threadNodes, unreadElsewhere } from "../../lib/chat-sidebar";
import { copyTextWithToast } from "../../lib/clipboard";
import { reads } from "../../lib/queries";
import { ReasonDialog } from "../governance";
import { ChannelNavProvider } from "./channel-nav";
import { ChatSheet, SheetClose } from "./ChatSheet";
import { ChatSidebar, UnreadBadge } from "./ChatSidebar";
import { Conversation } from "./Conversation";
import { NewChannelDialog } from "./NewChannelDialog";
import { PromoteDialog } from "./PromoteDialog";
import { ConversationSkeleton, EmptyState, ErrorState, SidebarSkeleton } from "./States";
import { ContextRail, ThreadPane } from "./ThreadPane";
import { useChannels } from "./useChannels";

export interface ChannelLocation {
  channel: string | null;
  thread?: string | null;
}

interface Props {
  nestId: string;
  nestName: string;
  onBack: () => void;
  /** The selected channel and open thread, from the URL. */
  channel: string | null;
  thread: string | null;
  /** Select a channel and/or open a thread; `replace` adds no Back stop. */
  onLocation: (loc: ChannelLocation, opts?: { replace?: boolean }) => void;
  onOpenNode: (nodeId: string) => void;
  /** A document mention in the sidebar opens the document's thread. */
  onOpenDocumentThread?: (nodeId: string, threadId: string) => void;
}

const fail = (fallback: string) => (e: unknown) => {
  toast.error((e as Error | undefined)?.message || fallback);
};

function useViewportWidth(): number {
  const [w, setW] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

/** The page fills the window under whatever the shell draws above it (the
 *  header, and on a phone the nest's tab strip): measured, not assumed. */
function usePageTop(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(64);
  useEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el) return;
      const t = Math.round(el.getBoundingClientRect().top + window.scrollY);
      setTop((cur) => (Math.abs(cur - t) > 1 ? t : cur));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return [ref, top];
}

export function ChatPage({ nestId, nestName, channel: selected, thread: openThread, onLocation, onOpenNode, onOpenDocumentThread }: Props) {
  const [pageRef, top] = usePageTop();
  const data = useChannels(nestId, selected, openThread);
  const { list, channel, timeline, actions } = data;
  const { adminStatus } = useAuth();
  const me = adminStatus?.me ?? null;
  const width = useViewportWidth();
  const layout = paneLayout(width);
  const mentionsQuery = useQuery(reads.myMentions());
  const mentions = useMemo(() => mentionsForNest(mentionsQuery.data?.mentions, nestId), [mentionsQuery.data, nestId]);

  // App hands a new callback each render; effects must not re-run for that.
  const go = useRef(onLocation);
  go.current = onLocation;
  const openNode = useRef(onOpenNode);
  openNode.current = onOpenNode;
  const nav = useMemo(() => ({ nestId, openNode: (nodeId: string) => openNode.current(nodeId) }), [nestId]);

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [promoting, setPromoting] = useState<ChannelPost | null>(null);
  const [archiving, setArchiving] = useState<ChannelSummary | null>(null);
  const [sidebarSheet, setSidebarSheet] = useState(false);

  // Landing with no channel in the URL: the most recently active one.
  useEffect(() => {
    if (selected || !list.data) return;
    const first = initialChannel(null, list.data);
    if (first) go.current({ channel: first }, { replace: true });
  }, [selected, list.data]);

  // A thread opened by a click is just opened. One that arrives with the URL
  // (a My Work mention, a copied link, Back/Forward) is scrolled to and flashed.
  const clicked = useRef<string | null>(null);
  const [arrived, setArrived] = useState<string | null>(null);
  useEffect(() => {
    setArrived(openThread && openThread !== clicked.current ? openThread : null);
  }, [selected, openThread]);
  // A permalink's message (C1): read once from the address.
  const [message] = useState(() => (typeof window === "undefined" ? null : readChannelDeepLink(window.location.search).message));

  // The unread count the channel was opened with, for the "New" line.
  const unreadAtOpen = useRef<{ channel: string; unread: number } | null>(null);
  const row = list.data?.channels.find((c) => c.name === selected) ?? null;
  if (selected && row && unreadAtOpen.current?.channel !== selected) unreadAtOpen.current = { channel: selected, unread: row.unread };

  const select = (name: string) => {
    clicked.current = null;
    setSidebarSheet(false);
    go.current({ channel: name });
  };
  const openThreadOf = (post: ChannelPost) => {
    clicked.current = post.id;
    go.current({ channel: selected, thread: post.id });
  };
  const closeThread = () => {
    clicked.current = null;
    go.current({ channel: selected, thread: null });
    // Back to the message the thread came from.
    if (openThread) document.getElementById(`message-${openThread}`)?.focus();
  };

  // Escape closes the thread pane (a sheet handles its own).
  useEffect(() => {
    if (!openThread || layout.thread !== "beside") return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("[role=dialog]") || t.closest("[role=menu]") || t.closest("[role=listbox]"))) return;
      closeThread();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openThread, layout.thread, selected]);

  const notify = (mentions: Parameters<typeof mentionNotice>[0]) => {
    const note = mentionNotice(mentions);
    if (note) toast.warning(note);
  };
  const post = async (body: string) => {
    try {
      notify(await actions.post(body));
    } catch (e) {
      fail("Could not post the message")(e);
      throw e;
    }
  };
  const reply = async (to: ChannelPost, body: string) => {
    try {
      notify(await actions.reply(to, body));
    } catch (e) {
      fail("Could not post the reply")(e);
      throw e;
    }
  };
  const promote = async (p: ChannelPost, input: { kind: "decision" | "task"; title: string; summary: string }) => {
    const r = await actions.promote(p.id, { kind: input.kind, title: input.title, ...(input.summary ? { summary: input.summary } : {}) });
    const open = { label: "Open", onClick: () => onOpenNode(r.node.id) };
    if (r.existing) toast.info(`This thread is already a ${input.kind}: ${r.node.title}`, { action: open });
    else toast.success(`Promoted to a ${input.kind}: ${r.node.title}`, { action: open });
  };
  const restore = (c: ChannelSummary) =>
    actions
      .setArchived(c.name, false)
      .then(() => toast.success(`${c.title} restored`))
      .catch(fail("Could not restore the channel"));
  const archive = async (c: ChannelSummary) => {
    await actions.setArchived(c.name, true);
    const next = list.live.find((x) => x.name !== c.name)?.name ?? null;
    go.current({ channel: next });
    toast.success(`${c.title} archived`, {
      action: {
        label: "Undo",
        onClick: () =>
          void actions
            .setArchived(c.name, false)
            .then(() => go.current({ channel: c.name }))
            .catch(fail("Could not restore the channel")),
      },
    });
  };
  const copyLink = (p: ChannelPost, messageId?: string) =>
    void copyTextWithToast(`${window.location.origin}${channelThreadLink(nestId, channel?.name ?? selected ?? "", p.id, messageId)}`, "Link copied");
  const openMention = (m: MentionItem) => {
    setSidebarSheet(false);
    if (m.kind === "channel" && m.channel) {
      clicked.current = null;
      go.current({ channel: m.channel, thread: m.thread_id });
    } else if (onOpenDocumentThread) onOpenDocumentThread(m.node_id, m.thread_id);
    else onOpenNode(m.node_id);
  };

  const sidebar = list.loading ? (
    <SidebarSkeleton />
  ) : list.error ? (
    <ErrorState title="Couldn't load channels" detail={list.error} onRetry={list.retry} className="m-3" />
  ) : (
    <ChatSidebar
      nestId={nestId}
      channels={list.live}
      archived={list.archived}
      selected={selected}
      canManage={list.canManage}
      mentions={mentions}
      viewer={me}
      onSelect={select}
      onNew={() => setCreating(true)}
      onRestore={(c) => void restore(c)}
      onOpenMention={openMention}
    />
  );

  const noChannels = !!list.data && list.live.length === 0 && !selected;
  const openPost = timeline.state?.posts.find((p) => p.id === openThread) ?? data.thread.data?.post ?? null;
  const threadRail = openThread && channel && layout.rail === "column";

  const threadPane = openThread && channel && (
    <ThreadPane
      nestId={nestId}
      channel={channel}
      post={openPost}
      thread={data.thread}
      canManage={list.canManage}
      people={data.roster.people}
      agents={data.roster.agents}
      draft={replyDrafts[openThread] ?? ""}
      onDraft={(next) => setReplyDrafts((d) => ({ ...d, [openThread]: next }))}
      onReply={reply}
      onSetResolved={(p, to) => void actions.setResolved(p.id, to).catch(fail("Could not update the thread"))}
      onPromote={setPromoting}
      onCopyLink={copyLink}
      onOpenNode={onOpenNode}
      onClose={closeThread}
      highlightMessage={message}
      rail={layout.rail}
      leading={layout.thread === "sheet" ? <SheetClose label="Close thread" /> : undefined}
      className={layout.thread === "beside" ? "w-[23rem] shrink-0 border-l" : undefined}
    />
  );

  const conversation = noChannels ? (
    <EmptyState
      icon={Hash}
      title="No channels yet"
      hint={list.canManage ? "Create the first one to give your team and its agents a place to talk." : "Someone who can edit this nest can create the first channel."}
      className="h-full"
    >
      {list.canManage && (
        <Button size="sm" onClick={() => setCreating(true)} data-testid="chat-first-channel">
          New channel
        </Button>
      )}
    </EmptyState>
  ) : timeline.error ? (
    <ErrorState
      title={timeline.notFound ? `There is no #${selected} here, or you can't open it` : `Couldn't load #${selected}`}
      detail={timeline.notFound ? null : timeline.error}
      onRetry={timeline.retry}
      className="m-4"
    >
      {list.live.some((c) => c.name !== selected) && (
        <Button size="sm" variant="ghost" onClick={() => select(initialChannel(null, list.data!) ?? list.live[0].name)}>
          Go to another channel
        </Button>
      )}
    </ErrorState>
  ) : !channel || !timeline.state ? (
    <ConversationSkeleton />
  ) : (
    <Conversation
      key={channel.name}
      channel={channel}
      state={timeline.state}
      me={me?.email ?? null}
      unreadAtOpen={unreadAtOpen.current?.channel === channel.name ? unreadAtOpen.current.unread : 0}
      canManage={list.canManage}
      people={data.roster.people}
      agents={data.roster.agents}
      openThread={openThread}
      highlightThread={arrived}
      draft={drafts[channel.name] ?? ""}
      onDraft={(next) => setDrafts((d) => ({ ...d, [channel.name]: next }))}
      onPost={post}
      onOpenThread={openThreadOf}
      onSetResolved={(p, to) => void actions.setResolved(p.id, to).catch(fail("Could not update the thread"))}
      onPromote={setPromoting}
      onCopyLink={(p) => copyLink(p)}
      onLoadMore={() => actions.loadMore().catch(fail("Could not load older posts"))}
      onOpenNode={onOpenNode}
      onArchive={() => setArchiving(channel)}
      onRestore={() => void restore(channel)}
      lag={list.lag}
      leading={
        layout.sidebar === "sheet" ? (
          <button type="button" onClick={() => setSidebarSheet(true)} aria-label="Channels" title="Channels" data-testid="chat-open-sidebar" className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <PanelLeft className="h-4 w-4" aria-hidden />
            <UnreadBadge count={unreadElsewhere(list.live, selected)} className="absolute -right-1 -top-1 min-w-4 px-1 text-[10px] leading-4" />
          </button>
        ) : undefined
      }
    />
  );

  return (
    <ChannelNavProvider value={nav}>
      <div ref={pageRef} className="flex min-h-[24rem] flex-col" style={{ height: `calc(100dvh - ${top}px)` }} data-testid="chat-page">
        <div className="flex min-h-0 flex-1">
          {layout.sidebar === "inline" ? (
            <aside className="w-[13.5rem] shrink-0 border-r bg-muted/20">{sidebar}</aside>
          ) : (
            <ChatSheet open={sidebarSheet} onOpenChange={setSidebarSheet} side="left" title="Channels" testId="chat-sidebar-sheet">
              <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
                <span className="text-sm font-semibold">{nestName}</span>
                <SheetClose />
              </div>
              <div className="min-h-0 flex-1">{sidebar}</div>
            </ChatSheet>
          )}
          <main className={cn("min-w-0 flex-1", openThread && layout.thread === "beside" && "min-w-[26rem]")}>{conversation}</main>
          {layout.thread === "beside" ? (
            threadPane
          ) : (
            <ChatSheet open={!!openThread && !!channel} onOpenChange={(o) => !o && closeThread()} side="right" title="Thread" className="w-[min(100vw,26rem)]" testId="chat-thread-sheet">
              {threadPane}
            </ChatSheet>
          )}
          {threadRail && (
            <aside className="w-56 shrink-0 border-l">
              <ContextRail
                nodes={threadNodes(data.thread.data?.post ?? openPost, data.thread.data?.replies ?? [], nestId)}
                canPromote={list.canManage && !channel.archived && !!openPost}
                onOpenNode={onOpenNode}
                onPromote={() => openPost && setPromoting(openPost)}
              />
            </aside>
          )}
        </div>
      </div>

      <NewChannelDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={async (name, purpose) => {
          const created = await actions.create(name, purpose);
          select(created.name);
        }}
      />
      <PromoteDialog post={promoting} onClose={() => setPromoting(null)} onPromote={promote} />
      <ReasonDialog
        open={!!archiving}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={archiving ? `Archive ${archiving.title}?` : ""}
        description="It leaves the channel list and stops taking new messages. Everything in it stays readable, and you can restore it from Archived."
        confirmLabel="Archive channel"
        onConfirm={async () => {
          if (archiving) await archive(archiving);
        }}
      />
    </ChannelNavProvider>
  );
}
