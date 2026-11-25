/**
 * useChannels — the chat page's one data hook (PO-1189, PO-1200).
 *
 * The open container is a channel (by name) or a conversation (`~uuid`, C2);
 * the same reads and writes serve both. Cached reads and the rule that ties
 * them together:
 *
 *  - the channel list and the conversation list, re-read on a cadence while
 *    the tab is visible (slower while the event stream is up, never in a
 *    hidden tab) and at once when it comes back;
 *  - the open container's timeline, and the open thread;
 *  - when the list says the open container has newer activity than the
 *    timeline on screen, or the stream says a message arrived in it, one
 *    "what is new" read is folded into both, so nothing is refetched that did
 *    not change and pages loaded with "Load more" stay. One pull per timeline
 *    at a time (`PullGuard`): a pull asked for while one runs makes it run
 *    once more, so a post that overlaps a pull is never dropped, and a pull
 *    on another timeline (the channel changed mid-pull) runs on its own.
 *
 * Resolve, reopen and promote are not messages, so the timeline and thread
 * are re-read after the caller's own and whenever the tab regains focus;
 * edits, reactions and deletes by others arrive as `message.changed` and
 * re-read their thread. Unread is cleared when a container is opened and
 * when messages arrive while it is open and visible.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../../auth/AuthContext";
import * as api from "../../lib/api";
import {
  CHANNEL_POLL_MS,
  PullGuard,
  TIMELINE_MAX,
  TIMELINE_PAGE,
  appendPage,
  appendReplies,
  applyNewMessages,
  channelPollInterval,
  hasNewActivity,
  splitChannels,
  toTimelineState,
  type TimelineState,
} from "../../lib/channels";
import { containerNodeId, keyOfConversationId, listPollInterval, parseContainerKey, type ChatEffect, type Container } from "../../lib/chat-live";
import { messageIdOf, reactionToggle } from "../../lib/chat-messages";
import { keys, reads } from "../../lib/queries";
import { useChatEvents, usePresence, useTyping } from "./useChatLive";

export interface ThreadState {
  post: api.ChannelPost;
  /** Oldest first. */
  replies: api.ChannelMessage[];
}

function useTabVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}

const message = (e: unknown): string => (e as Error | undefined)?.message || "Something went wrong";
const status = (e: unknown): number | undefined => (e as api.ApiError | undefined)?.status;

/** A conversation as the page reads a channel: the same row shape, so one
 *  list, one timeline and one header serve both. `conversation` keeps the
 *  members and kind for the header. */
export function conversationAsChannel(c: api.ConversationView): api.ChannelSummary {
  return {
    id: c.id,
    name: keyOfConversationId(c.id) ?? c.id,
    title: c.title,
    type: "channel",
    purpose: null,
    archived: false,
    post_count: c.post_count,
    last_post_at: c.last_post_at,
    last_activity_at: c.last_activity_at,
    unread: c.unread,
    can_post: c.can_post,
    post_refusal: c.post_refusal,
    private: true,
    member: true,
    conversation: c,
  };
}

/** The stored-time form the lists compare ("YYYY-MM-DD HH:MM:SS.mmm", UTC). */
const nowStored = () => new Date().toISOString().replace("T", " ").replace("Z", "");

type ConversationList = { conversations: api.ConversationView[] };

export function useChannels(nestId: string, selected: string | null, threadId: string | null, opts: { live?: boolean } = {}) {
  const qc = useQueryClient();
  const visible = useTabVisible();
  const { adminStatus } = useAuth();
  const me = adminStatus?.me?.email ?? null;
  const container: Container | null = useMemo(() => parseContainerKey(selected), [selected]);
  const nodeId = container ? containerNodeId(container) : "";
  const listKey = keys.channelList(nestId);
  const convKey = keys.conversations(nestId);
  const timelineKey = container?.kind === "conversation" ? keys.conversationTimeline(nestId, container.uuid) : keys.channelTimeline(nestId, container?.name ?? "");
  const threadKey =
    container?.kind === "conversation" ? keys.conversationThread(nestId, container.uuid, threadId ?? "") : keys.channelThread(nestId, container?.name ?? "", threadId ?? "");

  // ── Reads, by container kind ─────────────────────────────────────────
  const read = useMemo(() => {
    if (!container) return null;
    if (container.kind === "channel") {
      const name = container.name;
      return {
        timeline: (o: { limit?: number; offset?: number }) => api.getChannelTimeline(nestId, name, o).then(toTimelineState),
        // ponytail: first 200 replies (server max); page with offset if threads outgrow it.
        thread: (id: string) => api.getChannelThread(nestId, name, id, { limit: TIMELINE_MAX }).then((r) => r.thread),
        since: (cursor: string) =>
          api.getChannelSince(nestId, name, cursor).then((r) => ({ row: r.channel, messages: r.messages, has_more: r.has_more, next_since: r.next_since })),
        markRead: () => api.markChannelRead(nestId, name).then((r) => r.channel),
      };
    }
    const uuid = container.uuid;
    return {
      timeline: (o: { limit?: number; offset?: number }) =>
        api
          .getConversationTimeline(nestId, uuid, o)
          .then((t) => toTimelineState({ channel: conversationAsChannel(t.conversation), posts: t.posts, pagination: t.pagination, next_since: t.next_since })),
      thread: (id: string) => api.getConversationThread(nestId, uuid, id).then((r) => r.thread),
      since: (cursor: string) =>
        api
          .getConversationSince(nestId, uuid, cursor)
          .then((r) => ({ row: conversationAsChannel(r.conversation), messages: r.messages, has_more: r.has_more, next_since: r.next_since })),
      markRead: () => api.markConversationRead(nestId, uuid).then((r) => conversationAsChannel(r.conversation)),
    };
  }, [container, nestId]);

  // ── Live (C2) ────────────────────────────────────────────────────────
  const live = opts.live !== false;
  const [closedKey, setClosedKey] = useState<string | null>(null);
  const presence = usePresence(nestId, live);
  const typing = useTyping(nestId, nodeId || null);
  const pullRef = useRef<() => Promise<void>>(async () => undefined);
  const onEffects = useCallback(
    (effects: ChatEffect[]) => {
      const patchRows = (key: string, fn: (unread: number) => number, touch: boolean) => {
        qc.setQueryData<api.ChannelList>(listKey, (l) =>
          l ? { ...l, channels: l.channels.map((c) => (c.name === key ? { ...c, unread: fn(c.unread), ...(touch ? { last_activity_at: nowStored() } : {}) } : c)) } : l,
        );
        qc.setQueryData<ConversationList>(convKey, (d) =>
          d
            ? { ...d, conversations: d.conversations.map((c) => (keyOfConversationId(c.id) === key ? { ...c, unread: fn(c.unread), ...(touch ? { last_activity_at: nowStored() } : {}) } : c)) }
            : d,
        );
      };
      for (const e of effects) {
        switch (e.kind) {
          case "pull":
            void pullRef.current();
            break;
          case "bump":
            patchRows(e.key, (n) => n + 1, true);
            break;
          case "zero":
            patchRows(e.key, () => 0, false);
            break;
          case "reread":
            if (e.key === selected) {
              void qc.invalidateQueries({ queryKey: timelineKey });
              if (threadId === e.thread) void qc.invalidateQueries({ queryKey: threadKey });
            }
            break;
          case "refetch":
            if (e.what === "channels") void qc.invalidateQueries({ queryKey: listKey });
            else if (e.what === "conversations") void qc.invalidateQueries({ queryKey: convKey });
            else void qc.invalidateQueries({ queryKey: [...keys.channels(nestId), "members"] });
            break;
          case "typing":
            typing.heard(e.key, e.who);
            break;
          case "presence":
            presence.patch(e);
            break;
          case "closed":
            void qc.invalidateQueries({ queryKey: convKey });
            void qc.invalidateQueries({ queryKey: listKey });
            setClosedKey(e.key);
            break;
          case "reset":
            void qc.invalidateQueries({ queryKey: listKey });
            void qc.invalidateQueries({ queryKey: convKey });
            void pullRef.current();
            break;
          default:
            break;
        }
      }
    },
    [qc, listKey, convKey, timelineKey, threadKey, selected, threadId, nestId, typing, presence],
  );
  const connected = useChatEvents(nestId, live, onEffects, { me, openKey: selected });

  // ── Lists ────────────────────────────────────────────────────────────
  const list = useQuery({
    ...reads.channelList(nestId),
    refetchInterval: (q) => {
      const usual = channelPollInterval(status(q.state.error));
      if (usual === false || !visible) return false;
      return listPollInterval(connected, usual);
    },
  });
  const conversations = useQuery({
    ...reads.conversations(nestId),
    refetchInterval: visible ? listPollInterval(connected, CHANNEL_POLL_MS) : false,
    refetchOnWindowFocus: "always",
    retry: false,
  });
  const people = useQuery(reads.mentionable(nestId));
  const agents = useQuery(reads.agentHandles(nestId));

  const timeline = useQuery({
    queryKey: timelineKey,
    enabled: !!read,
    staleTime: 0,
    refetchOnWindowFocus: "always",
    queryFn: async () => {
      // A re-read asks for as much as is on screen, so it does not drop pages.
      const shown = qc.getQueryData<TimelineState>(timelineKey)?.posts.length ?? 0;
      const limit = Math.min(TIMELINE_MAX, Math.max(TIMELINE_PAGE, shown));
      return read!.timeline({ limit });
    },
  });

  const thread = useQuery({
    queryKey: threadKey,
    enabled: !!read && !!threadId,
    staleTime: 0,
    refetchOnWindowFocus: "always",
    queryFn: (): Promise<ThreadState> => read!.thread(threadId!),
  });

  const { live: liveChannels, archived } = useMemo(() => splitChannels(list.data?.channels ?? []), [list.data]);
  const convRows = useMemo(() => (conversations.data?.conversations ?? []).map(conversationAsChannel), [conversations.data]);
  // People on the nest only: with the wider directory on, the roster also
  // carries suggestions (`member: false`) who are not here to be mentioned.
  const roster = useMemo(
    () => ({
      people: (people.data?.people ?? EMPTY_PEOPLE).filter((p) => p.member !== false),
      agents: agents.data?.agents ?? EMPTY_AGENTS,
    }),
    [people.data, agents.data],
  );
  const row =
    container?.kind === "conversation" ? (convRows.find((c) => c.name === selected) ?? null) : (list.data?.channels.find((c) => c.name === selected) ?? null);
  const held = timeline.data ?? null;
  // The timeline's copy reads archived and unlisted channels too; the polled
  // row is fresher for unread and for what the caller may do.
  const channel: api.ChannelSummary | null = held ? { ...held.channel, ...(row ?? {}) } : row;

  // ── What is new ──────────────────────────────────────────────────────
  const guard = useRef(new PullGuard());
  const pullNew = useCallback(async () => {
    if (!read) return;
    const key = JSON.stringify(timelineKey);
    const mark = guard.current.start(key);
    if (!mark) return;
    try {
      do {
        const cursor = qc.getQueryData<TimelineState>(timelineKey)?.next_since;
        if (!cursor) break;
        let since = cursor;
        let missing = false;
        for (;;) {
          const r = await read.since(since);
          qc.setQueryData<TimelineState>(timelineKey, (t) => {
            if (!t) return t;
            const merged = applyNewMessages(t.posts, r.messages);
            missing = missing || merged.missing;
            return { ...t, channel: r.row, posts: merged.posts, total: t.total + (merged.posts.length - t.posts.length), next_since: r.next_since };
          });
          if (threadId) {
            qc.setQueryData<ThreadState>(threadKey, (th) => {
              if (!th) return th;
              const replies = appendReplies(th.replies, r.messages, threadId);
              const more = replies.length - th.replies.length;
              return more ? { post: { ...th.post, reply_count: th.post.reply_count + more }, replies } : th;
            });
          }
          if (!r.has_more || r.next_since === since) break;
          since = r.next_since;
        }
        // A reply to a post further down than what is loaded: re-read so it
        // takes its place at the top.
        if (missing) await qc.invalidateQueries({ queryKey: timelineKey });
      } while (guard.current.shouldRepeat(mark));
    } catch {
      // A cursor the server no longer takes, or a failed read: the full
      // re-read brings the timeline and a fresh cursor.
      await qc.invalidateQueries({ queryKey: timelineKey });
    } finally {
      guard.current.finish(key);
    }
  }, [qc, read, threadId, timelineKey, threadKey]);
  pullRef.current = pullNew;

  const rowActivity = row?.last_activity_at ?? null;
  const heldActivity = held?.channel.last_activity_at ?? null;
  const loaded = !!held;
  useEffect(() => {
    if (!loaded || !rowActivity) return;
    if (hasNewActivity({ last_activity_at: rowActivity }, { last_activity_at: heldActivity })) void pullNew();
  }, [loaded, rowActivity, heldActivity, pullNew]);

  // ── Mark read: on open, and when messages arrive while open and visible ──
  const marking = useRef<string | null>(null);
  const unread = row?.unread ?? 0;
  useEffect(() => {
    if (!read || !selected || !loaded || !visible || unread <= 0 || marking.current === selected) return;
    marking.current = selected;
    read
      .markRead()
      .then((done) => {
        qc.setQueryData<api.ChannelList>(listKey, (l) => (l ? { ...l, channels: l.channels.map((c) => (c.name === done.name ? { ...c, unread: 0 } : c)) } : l));
        qc.setQueryData<ConversationList>(convKey, (d) => (d ? { ...d, conversations: d.conversations.map((c) => (c.id === done.id ? { ...c, unread: 0 } : c)) } : d));
      })
      .catch(() => undefined) // their own mark; the next change tries again
      .finally(() => {
        marking.current = null;
      });
  }, [qc, read, selected, loaded, visible, unread, listKey, convKey]);

  // ── Writes ───────────────────────────────────────────────────────────
  const rereadOpen = useCallback(
    () => Promise.all([qc.invalidateQueries({ queryKey: timelineKey }), threadId ? qc.invalidateQueries({ queryKey: threadKey }) : null]),
    [qc, timelineKey, threadKey, threadId],
  );
  const channelName = container?.kind === "channel" ? container.name : null;

  const actions = useMemo(
    () => ({
      /** Post a message; resolves to what became of each @mention. */
      post: async (body: string) => {
        const r = await api.createAnnotation(nestId, nodeId, { body, anchor: null });
        await pullNew();
        return r.mentions;
      },
      reply: async (post: api.ChannelPost, body: string) => {
        const r = await api.replyAnnotation(nestId, nodeId, post.id, body);
        // Replying reopens a resolved thread, and a status change is not a message.
        await (post.status === "resolved" ? rereadOpen() : pullNew());
        return r.mentions;
      },
      setResolved: async (postId: string, resolved: boolean) => {
        await (resolved ? api.resolveAnnotation : api.reopenAnnotation)(nestId, nodeId, postId);
        await rereadOpen();
      },
      promote: async (postId: string, input: { kind: "decision" | "task"; title?: string; summary?: string }) => {
        const r = await api.promoteThread(nestId, postId, input);
        await rereadOpen();
        return r;
      },
      create: async (name: string, purpose: string, isPrivate = false) =>
        (await api.createChannel(nestId, { name, purpose: purpose || undefined, ...(isPrivate ? { private: true } : {}) })).channel,
      setArchived: async (name: string, to: boolean) => {
        const r = await api.archiveChannel(nestId, name, to);
        await qc.invalidateQueries({ queryKey: keys.channelTimeline(nestId, name) });
        return r.channel;
      },
      // ── C1 (PO-1196): one message. Channel messages only: the message
      // routes live under the channel. Each write returns the message as the
      // server now holds it; the copy on screen is patched in place (the
      // timeline's post keeps its thread fields), so nothing is refetched
      // for a reaction.
      react: async (m: api.ChannelMessage | api.ChannelPost, emoji: string) => {
        if (!channelName) return;
        const id = messageIdOf(m);
        const r = await (reactionToggle(m.reactions, emoji) === "add" ? api.reactToMessage : api.unreactToMessage)(nestId, channelName, id, emoji);
        patchEverywhere(qc, timelineKey, threadKey, m.id, { reactions: r.reactions });
      },
      edit: async (m: api.ChannelMessage | api.ChannelPost, body: string) => {
        if (!channelName) throw new Error("No channel");
        const r = await api.editMessage(nestId, channelName, messageIdOf(m), body);
        patchEverywhere(qc, timelineKey, threadKey, m.id, { body: r.message.body, edited_at: r.message.edited_at, mentions: r.message.mentions, cards: r.message.cards });
        return r.mentions;
      },
      remove: async (m: api.ChannelMessage | api.ChannelPost) => {
        if (!channelName) return;
        const r = await api.deleteMessage(nestId, channelName, messageIdOf(m));
        const t = r.message;
        patchEverywhere(qc, timelineKey, threadKey, m.id, {
          body: "",
          deleted: true,
          deleted_at: t.deleted_at,
          deleted_by: t.deleted_by,
          reactions: [],
          pinned: false,
          saved: false,
          mentions: [],
          cards: [],
        });
      },
      setPinned: async (m: api.ChannelMessage | api.ChannelPost, pinned: boolean) => {
        if (!channelName) return;
        const r = await api.setMessagePinned(nestId, channelName, messageIdOf(m), pinned);
        patchEverywhere(qc, timelineKey, threadKey, m.id, { pinned: r.message.pinned });
      },
      setSaved: async (m: api.ChannelMessage | api.ChannelPost, saved: boolean) => {
        if (!channelName) return;
        const r = await api.setMessageSaved(nestId, channelName, messageIdOf(m), saved);
        patchEverywhere(qc, timelineKey, threadKey, m.id, { saved: r.message.saved });
      },
      // ── C2 (PO-1197): conversations and membership ──
      /** Start (or find) a conversation; resolves to its container key. */
      startConversation: async (members: string[]) => {
        const r = await api.createConversation(nestId, members);
        await qc.invalidateQueries({ queryKey: convKey });
        return keyOfConversationId(r.conversation.id) ?? r.conversation.id;
      },
      addMember: async (member: string) => {
        if (!container) return;
        if (container.kind === "conversation") await api.addConversationMember(nestId, container.uuid, member);
        else await api.inviteChannelMember(nestId, container.name, member);
      },
      leave: async () => {
        if (!container) return;
        if (container.kind === "conversation") await api.leaveConversation(nestId, container.uuid);
        else await api.leaveChannel(nestId, container.name);
      },
      join: async () => {
        if (!channelName) return;
        await api.joinChannel(nestId, channelName);
      },
      setPrivate: async (to: boolean) => {
        if (!channelName) return;
        await api.setChannelPrivate(nestId, channelName, to);
      },
      /** The next page of older posts. */
      loadMore: async () => {
        const shown = qc.getQueryData<TimelineState>(timelineKey)?.posts.length ?? 0;
        if (!read) return;
        const page = await read.timeline({ limit: TIMELINE_PAGE, offset: shown });
        qc.setQueryData<TimelineState>(timelineKey, (t) => (t ? { ...t, posts: appendPage(t.posts, page.posts), total: page.total, has_more: page.has_more } : t));
      },
    }),
    [qc, nestId, nodeId, channelName, container, read, timelineKey, threadKey, convKey, pullNew, rereadOpen],
  );

  return {
    me,
    container,
    nodeId,
    list: {
      data: list.data ?? null,
      live: liveChannels,
      archived,
      canManage: list.data?.can_manage === true,
      loading: list.isLoading,
      error: list.isError && !list.data ? message(list.error) : null,
      retry: () => void list.refetch(),
      /** Changes on every poll, so "2m ago" labels keep moving while visible. */
      refreshedAt: list.dataUpdatedAt,
      /** The poll has failed since it last succeeded (AC-C3-09): the page
       *  shows "Reconnecting…" with when it last heard from the server. */
      lag: { stale: list.isError && !!list.data, lastSuccessAt: list.dataUpdatedAt || null },
    },
    conversations: {
      rows: convRows,
      loading: conversations.isLoading,
      /** 404 while the nest's chat is off or for a non-member: no section. */
      available: !conversations.isError,
    },
    channel,
    timeline: {
      state: held,
      loading: !!read && !held && !timeline.isError,
      error: timeline.isError && !held ? message(timeline.error) : null,
      notFound: timeline.isError && !held && status(timeline.error) === 404,
      retry: () => void timeline.refetch(),
    },
    thread: {
      data: thread.data ?? null,
      loading: !!threadId && !thread.data && !thread.isError,
      error: thread.isError && !thread.data ? message(thread.error) : null,
      retry: () => void thread.refetch(),
    },
    roster,
    live: {
      connected,
      online: presence.online,
      active: presence.active,
      typingLine: typing.line(selected),
      onType: typing.onType,
      /** A container I was removed from (the page leaves it). */
      closedKey,
      clearClosed: () => setClosedKey(null),
    },
    actions,
  };
}

/** One message's new fields, wherever the page holds it: the timeline's
 *  post, the open thread's post, or one of its replies. */
function patchEverywhere(qc: ReturnType<typeof useQueryClient>, timelineKey: readonly unknown[], threadKey: readonly unknown[], id: string, patch: Partial<api.ChannelMessage>) {
  qc.setQueryData<TimelineState>(timelineKey, (t) => (t ? { ...t, posts: t.posts.map((p) => (p.id === id ? { ...p, ...patch } : p)) } : t));
  qc.setQueryData<ThreadState>(threadKey, (th) =>
    th
      ? {
          post: th.post.id === id ? { ...th.post, ...patch } : th.post,
          replies: th.replies.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        }
      : th,
  );
}

const EMPTY_PEOPLE: Array<{ email: string; name: string | null; member?: boolean }> = [];
const EMPTY_AGENTS: api.AgentHandle[] = [];

export type ChannelsData = ReturnType<typeof useChannels>;
