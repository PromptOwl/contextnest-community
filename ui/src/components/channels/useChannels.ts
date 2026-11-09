/**
 * useChannels — the Channels page's one data hook (PO-1189).
 *
 * Three cached reads and the rule that ties them together:
 *
 *  - the channel list, re-read every ~12 s while the tab is visible and at
 *    once when it comes back (never in a hidden tab);
 *  - the open channel's timeline, and the open thread;
 *  - when the list says the open channel has newer activity than the timeline
 *    on screen, one "what is new" read is folded into both, so nothing is
 *    refetched that did not change and pages loaded with "Load more" stay.
 *
 * Resolve, reopen and promote are not messages, so the timeline and thread
 * are re-read after the caller's own and whenever the tab regains focus.
 * Unread is cleared when a channel is opened and when messages arrive while
 * it is open and visible.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../../lib/api";
import { keys, reads } from "../../lib/queries";
import {
  TIMELINE_MAX,
  TIMELINE_PAGE,
  appendPage,
  appendReplies,
  applyNewMessages,
  hasNewActivity,
  splitChannels,
  toTimelineState,
  type TimelineState,
} from "../../lib/channels";

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

export function useChannels(nestId: string, selected: string | null, threadId: string | null) {
  const qc = useQueryClient();
  const visible = useTabVisible();
  const listKey = keys.channelList(nestId);
  const timelineKey = keys.channelTimeline(nestId, selected ?? "");
  const threadKey = keys.channelThread(nestId, selected ?? "", threadId ?? "");

  const list = useQuery(reads.channelList(nestId));
  const people = useQuery(reads.mentionable(nestId));
  const agents = useQuery(reads.agentHandles(nestId));

  const timeline = useQuery({
    queryKey: timelineKey,
    enabled: !!selected,
    staleTime: 0,
    refetchOnWindowFocus: "always",
    queryFn: async () => {
      // A re-read asks for as much as is on screen, so it does not drop pages.
      const shown = qc.getQueryData<TimelineState>(timelineKey)?.posts.length ?? 0;
      const limit = Math.min(TIMELINE_MAX, Math.max(TIMELINE_PAGE, shown));
      return toTimelineState(await api.getChannelTimeline(nestId, selected!, { limit }));
    },
  });

  const thread = useQuery({
    queryKey: threadKey,
    enabled: !!selected && !!threadId,
    staleTime: 0,
    refetchOnWindowFocus: "always",
    queryFn: async (): Promise<ThreadState> => (await api.getChannelThread(nestId, selected!, threadId!)).thread,
  });

  const { live, archived } = useMemo(() => splitChannels(list.data?.channels ?? []), [list.data]);
  const row = list.data?.channels.find((c) => c.name === selected) ?? null;
  const held = timeline.data ?? null;
  // The timeline's copy reads archived and unlisted channels too; the polled
  // row is fresher for unread and for what the caller may do.
  const channel: api.ChannelSummary | null = held ? { ...held.channel, ...(row ?? {}) } : row;

  // ── What is new ────────────────────────────────────────────────────────
  const pulling = useRef(false);
  const pullNew = useCallback(async () => {
    const cursor = qc.getQueryData<TimelineState>(timelineKey)?.next_since;
    if (!selected || !cursor || pulling.current) return;
    pulling.current = true;
    try {
      let since = cursor;
      let missing = false;
      for (;;) {
        const r = await api.getChannelSince(nestId, selected, since);
        qc.setQueryData<TimelineState>(timelineKey, (t) => {
          if (!t) return t;
          const merged = applyNewMessages(t.posts, r.messages);
          missing = missing || merged.missing;
          return {
            ...t,
            channel: r.channel,
            posts: merged.posts,
            total: t.total + (merged.posts.length - t.posts.length),
            next_since: r.next_since,
          };
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
    } catch {
      // A cursor the server no longer takes, or a failed read: the full
      // re-read brings the timeline and a fresh cursor.
      await qc.invalidateQueries({ queryKey: timelineKey });
    } finally {
      pulling.current = false;
    }
  }, [qc, nestId, selected, threadId, timelineKey, threadKey]);

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
    if (!selected || !loaded || !visible || unread <= 0 || marking.current === selected) return;
    marking.current = selected;
    api
      .markChannelRead(nestId, selected)
      .then(({ channel: read }) =>
        qc.setQueryData<api.ChannelList>(listKey, (l) =>
          l ? { ...l, channels: l.channels.map((c) => (c.name === read.name ? { ...c, unread: 0 } : c)) } : l,
        ),
      )
      .catch(() => undefined) // their own mark; the next change tries again
      .finally(() => {
        marking.current = null;
      });
  }, [qc, nestId, selected, loaded, visible, unread, listKey]);

  // ── Writes ─────────────────────────────────────────────────────────────
  const rereadOpen = useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: timelineKey }),
        threadId ? qc.invalidateQueries({ queryKey: threadKey }) : null,
      ]),
    [qc, timelineKey, threadKey, threadId],
  );

  const channelId = channel?.id ?? (selected ? `nodes/channels/${selected}` : "");
  const actions = useMemo(
    () => ({
      /** Post a message; resolves to what became of each @mention. */
      post: async (body: string) => {
        const r = await api.createAnnotation(nestId, channelId, { body, anchor: null });
        await pullNew();
        return r.mentions;
      },
      reply: async (post: api.ChannelPost, body: string) => {
        const r = await api.replyAnnotation(nestId, channelId, post.id, body);
        // Replying reopens a resolved thread, and a status change is not a message.
        await (post.status === "resolved" ? rereadOpen() : pullNew());
        return r.mentions;
      },
      setResolved: async (postId: string, resolved: boolean) => {
        await (resolved ? api.resolveAnnotation : api.reopenAnnotation)(nestId, channelId, postId);
        await rereadOpen();
      },
      promote: async (postId: string, input: { kind: "decision" | "task"; title?: string; summary?: string }) => {
        const r = await api.promoteThread(nestId, postId, input);
        await rereadOpen();
        return r;
      },
      create: async (name: string, purpose: string) =>
        (await api.createChannel(nestId, { name, purpose: purpose || undefined })).channel,
      setArchived: async (name: string, to: boolean) => {
        const r = await api.archiveChannel(nestId, name, to);
        await qc.invalidateQueries({ queryKey: keys.channelTimeline(nestId, name) });
        return r.channel;
      },
      /** The next page of older posts. */
      loadMore: async () => {
        const shown = qc.getQueryData<TimelineState>(timelineKey)?.posts.length ?? 0;
        if (!selected) return;
        const page = await api.getChannelTimeline(nestId, selected, { limit: TIMELINE_PAGE, offset: shown });
        qc.setQueryData<TimelineState>(timelineKey, (t) =>
          t
            ? { ...t, posts: appendPage(t.posts, page.posts), total: page.pagination.total, has_more: page.pagination.has_more }
            : t,
        );
      },
    }),
    [qc, nestId, channelId, selected, timelineKey, pullNew, rereadOpen],
  );

  return {
    list: {
      data: list.data ?? null,
      live,
      archived,
      canManage: list.data?.can_manage === true,
      loading: list.isLoading,
      error: list.isError && !list.data ? message(list.error) : null,
      retry: () => void list.refetch(),
      /** Changes on every poll, so "2m ago" labels keep moving while visible. */
      refreshedAt: list.dataUpdatedAt,
    },
    channel,
    timeline: {
      state: held,
      loading: !!selected && !held && !timeline.isError,
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
    roster: {
      people: people.data?.people ?? EMPTY_PEOPLE,
      agents: agents.data?.agents ?? EMPTY_AGENTS,
    },
    actions,
  };
}

const EMPTY_PEOPLE: Array<{ email: string; name: string | null }> = [];
const EMPTY_AGENTS: api.AgentHandle[] = [];

export type ChannelsData = ReturnType<typeof useChannels>;
