/**
 * Channels — the agent team stream for people (PO-1189), experimental.
 *
 * The nest's channels beside the open channel's conversation: posts ordered
 * by latest activity, each opening its thread in place. Agents post over MCP
 * and show as "<agent>, on behalf of <person>". Every person added to the
 * nest reads and posts; creating, archiving and promoting are for writers.
 *
 * This component only lays the page out and turns clicks into actions:
 * `useChannels` owns the data and the refresh, the URL (through `location`)
 * owns which channel and thread are open, and each part of the screen is its
 * own component in this folder.
 */
import { useEffect, useRef, useState } from "react";
import { Hash } from "lucide-react";
import { toast } from "sonner";
import { BetaBadge } from "@/components/ui/beta-badge";
import { Button } from "@/components/ui/button";
import type { ChannelPost, ChannelSummary } from "../../lib/api";
import { channelThreadLink } from "../../lib/channel-deep-link";
import { initialChannel, mentionNotice } from "../../lib/channels";
import { copyTextWithToast } from "../../lib/clipboard";
import { ReasonDialog } from "../governance";
import { NestPageHeader } from "../NestPageHeader";
import { ChannelHeader } from "./ChannelHeader";
import { ChannelList, ChannelSwitcher, NewChannelButton } from "./ChannelList";
import { Composer, PostRefusal } from "./Composer";
import { NewChannelDialog } from "./NewChannelDialog";
import { PromoteDialog } from "./PromoteDialog";
import { EmptyState, ErrorState, LoadingState } from "./StateBlocks";
import { Timeline } from "./Timeline";
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
}

const fail = (fallback: string) => (e: unknown) => {
  toast.error((e as Error | undefined)?.message || fallback);
};

export function ChannelsPage({ nestId, nestName, onBack, channel: selected, thread: openThread, onLocation, onOpenNode }: Props) {
  const data = useChannels(nestId, selected, openThread);
  const { list, channel, timeline, actions } = data;
  // App hands a new callback each render; effects must not re-run for that.
  const go = useRef(onLocation);
  go.current = onLocation;

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const [promoting, setPromoting] = useState<ChannelPost | null>(null);
  const [archiving, setArchiving] = useState<ChannelSummary | null>(null);

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

  const select = (name: string) => {
    clicked.current = null;
    go.current({ channel: name });
  };
  const toggleThread = (id: string) => {
    clicked.current = openThread === id ? null : id;
    go.current({ channel: selected, thread: openThread === id ? null : id });
  };

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

  const listProps = {
    channels: list.live,
    archived: list.archived,
    selected,
    canManage: list.canManage,
    onSelect: select,
    onNew: () => setCreating(true),
    onRestore: (c: ChannelSummary) => void restore(c),
  };
  const noChannels = !!list.data && list.live.length === 0 && !selected;

  return (
    <div className="px-4 py-4 md:px-6">
      <NestPageHeader nestName={nestName} onBack={onBack} title={<h1 className="text-xl font-semibold">Channels</h1>} badges={<BetaBadge />} />

      {list.error ? (
        <ErrorState title="Couldn't load channels" detail={list.error} onRetry={list.retry} />
      ) : list.loading ? (
        <LoadingState label="Loading channels…" />
      ) : (
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="md:hidden">
            <ChannelSwitcher {...listProps} />
          </div>
          <div className="hidden md:block">
            <ChannelList {...listProps} />
          </div>

          <section className="min-w-0 max-w-3xl" aria-label={channel?.title ?? "Conversation"}>
            {noChannels ? (
              <EmptyState
                icon={Hash}
                title="No channels yet"
                hint={
                  list.canManage
                    ? "Create the first one to give your team and its agents a place to talk."
                    : "Someone who can edit this nest can create the first channel."
                }
              >
                {list.canManage && <NewChannelButton onNew={() => setCreating(true)} />}
              </EmptyState>
            ) : timeline.error ? (
              <ErrorState
                title={timeline.notFound ? `There is no #${selected} here, or you can't open it` : `Couldn't load #${selected}`}
                detail={timeline.notFound ? null : timeline.error}
                onRetry={timeline.retry}
              >
                {list.live.some((c) => c.name !== selected) && (
                  <Button size="sm" variant="ghost" onClick={() => select(initialChannel(null, list.data!) ?? list.live[0].name)}>
                    Go to another channel
                  </Button>
                )}
              </ErrorState>
            ) : !channel || !timeline.state ? (
              <LoadingState label="Loading messages…" />
            ) : (
              <div className="space-y-4">
                <ChannelHeader
                  channel={channel}
                  canManage={list.canManage}
                  onArchive={() => setArchiving(channel)}
                  onRestore={() => void restore(channel)}
                />
                {channel.can_post ? (
                  <Composer
                    key={channel.name}
                    value={drafts[channel.name] ?? ""}
                    onChange={(next) => setDrafts((d) => ({ ...d, [channel.name]: next }))}
                    onSend={post}
                    people={data.roster.people}
                    agents={data.roster.agents}
                    placeholder={`Message ${channel.title}`}
                    sendLabel="Send"
                    ariaLabel={`Message ${channel.title}`}
                  />
                ) : (
                  <PostRefusal channel={channel} />
                )}
                <Timeline
                  state={timeline.state}
                  channel={channel}
                  canManage={list.canManage}
                  thread={data.thread}
                  people={data.roster.people}
                  agents={data.roster.agents}
                  openThread={openThread}
                  highlightThread={arrived}
                  replyDrafts={replyDrafts}
                  onReplyDraft={(id, next) => setReplyDrafts((d) => ({ ...d, [id]: next }))}
                  onToggle={toggleThread}
                  onReply={reply}
                  onSetResolved={(p, resolved) => void actions.setResolved(p.id, resolved).catch(fail("Could not update the thread"))}
                  onPromote={setPromoting}
                  onCopyLink={(p) => void copyTextWithToast(`${window.location.origin}${channelThreadLink(nestId, channel.name, p.id)}`, "Link copied")}
                  onLoadMore={() => actions.loadMore().catch(fail("Could not load older posts"))}
                  onOpenNode={onOpenNode}
                />
              </div>
            )}
          </section>
        </div>
      )}

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
    </div>
  );
}
