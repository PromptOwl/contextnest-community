/** Channels usability pass (PO-1189): the page's rules as plain functions, named by acceptance criterion. */
import { describe, expect, it } from "vitest";
import type { ChannelList, ChannelNewMessage, ChannelPost, ChannelSummary, PostedMention } from "./api";
import {
  CHANNEL_POLL_MS,
  appendPage,
  appendReplies,
  applyNewMessages,
  authorOf,
  channelPollInterval,
  hasNewActivity,
  initialChannel,
  mentionNotice,
  promoteTitle,
  replyLabel,
  splitChannels,
  unreadLabel,
} from "./channels";
import { reads } from "./queries";

const channel = (name: string, over: Partial<ChannelSummary> = {}): ChannelSummary => ({
  id: `nodes/channels/${name}`,
  name,
  title: `#${name}`,
  type: "channel",
  purpose: null,
  archived: false,
  post_count: 0,
  last_post_at: null,
  last_activity_at: null,
  unread: 0,
  can_post: true,
  post_refusal: null,
  ...over,
});

const post = (id: string, at: string, over: Partial<ChannelPost> = {}): ChannelPost => ({
  id,
  author: "walt@team.test",
  author_name: "Walt Writer",
  actor: { human: "Walt Writer", agent: null, label: "Walt Writer" },
  body: `post ${id}`,
  created_at: at,
  cards: [],
  mentions: [],
  status: "open",
  reply_count: 0,
  last_reply_at: null,
  last_activity_at: at,
  promoted: [],
  ...over,
});

const incoming = (id: string, thread: string, at: string, reply: boolean): ChannelNewMessage => ({
  id,
  thread_id: thread,
  reply,
  author: "rita@team.test",
  author_name: "Rita Reader",
  actor: { human: "Rita Reader", agent: null, label: "Rita Reader" },
  body: `message ${id}`,
  created_at: at,
  cards: [],
  mentions: [],
});

describe("AC-UX-03 live refresh", () => {
  it("polls the channel list about every 12 seconds, and never while the tab is hidden", () => {
    const q = reads.channelList("nest-1");
    expect(CHANNEL_POLL_MS).toBeGreaterThanOrEqual(10_000);
    expect(CHANNEL_POLL_MS).toBeLessThanOrEqual(15_000);
    const interval = q.refetchInterval as (query: { state: { error: unknown } }) => number | false;
    expect(interval({ state: { error: null } })).toBe(CHANNEL_POLL_MS);
    // A transient failure keeps the pace; "you have no channels here" stops it.
    expect(interval({ state: { error: { status: 500 } } })).toBe(CHANNEL_POLL_MS);
    expect(interval({ state: { error: { status: 404 } } })).toBe(false);
    expect(channelPollInterval(403)).toBe(false);
    expect(q.refetchIntervalInBackground).toBe(false);
    // Coming back to the tab re-reads at once.
    expect(q.refetchOnWindowFocus).toBe("always");
  });

  it("fetches what is new only when the open channel's activity moved", () => {
    const held = channel("ops", { last_activity_at: "2026-11-09 13:41:44.927" });
    expect(hasNewActivity(channel("ops", { last_activity_at: "2026-11-09 13:41:44.927" }), held)).toBe(false);
    expect(hasNewActivity(channel("ops", { last_activity_at: "2026-11-09 13:52:10.004" }), held)).toBe(true);
    // An empty channel that got its first message.
    expect(hasNewActivity(channel("ops", { last_activity_at: "2026-11-09 13:52:10.004" }), channel("ops"))).toBe(true);
    expect(hasNewActivity(channel("ops"), channel("ops"))).toBe(false);
  });

  it("puts a new post from someone else at the top", () => {
    const posts = [post("t1", "2026-11-09 10:00:00.000")];
    const r = applyNewMessages(posts, [incoming("m9", "t9", "2026-11-09 10:05:00.000", false)]);
    expect(r.posts.map((p) => p.id)).toEqual(["t9", "t1"]);
    expect(r.posts[0]).toMatchObject({ id: "t9", status: "open", reply_count: 0, last_activity_at: "2026-11-09 10:05:00.000", promoted: [] });
    expect(r.added).toBe(1);
    expect(r.missing).toBe(false);
  });

  it("does not add a post twice when the same message arrives again", () => {
    const first = applyNewMessages([], [incoming("m9", "t9", "2026-11-09 10:05:00.000", false)]);
    const again = applyNewMessages(first.posts, [incoming("m9", "t9", "2026-11-09 10:05:00.000", false)]);
    expect(again.posts).toHaveLength(1);
    expect(again.added).toBe(0);
  });
});

describe("AC-UX-04 a reply moves its post to the top", () => {
  it("bumps the reply count and the activity time, and reorders", () => {
    const posts = [post("t2", "2026-11-09 10:02:00.000"), post("t1", "2026-11-09 10:00:00.000", { reply_count: 2 })];
    const r = applyNewMessages(posts, [incoming("m5", "t1", "2026-11-09 10:09:00.000", true)]);
    expect(r.posts.map((p) => p.id)).toEqual(["t1", "t2"]);
    expect(r.posts[0]).toMatchObject({ reply_count: 3, last_reply_at: "2026-11-09 10:09:00.000", last_activity_at: "2026-11-09 10:09:00.000" });
  });

  it("ignores a reply the post already counts (a re-read that raced the refresh)", () => {
    const posts = [post("t1", "2026-11-09 10:00:00.000", { reply_count: 3, last_activity_at: "2026-11-09 10:09:00.000" })];
    const r = applyNewMessages(posts, [incoming("m5", "t1", "2026-11-09 10:09:00.000", true)]);
    expect(r.posts[0].reply_count).toBe(3);
  });

  it("says so when a reply belongs to a post that is not loaded, so the page re-reads", () => {
    const r = applyNewMessages([post("t2", "2026-11-09 10:02:00.000")], [incoming("m5", "old", "2026-11-09 10:09:00.000", true)]);
    expect(r.missing).toBe(true);
    expect(r.posts.map((p) => p.id)).toEqual(["t2"]);
  });

  it("appends new replies to the open thread only, once", () => {
    const have = [incoming("m1", "t1", "2026-11-09 10:01:00.000", true)];
    const next = appendReplies(have, [
      incoming("m1", "t1", "2026-11-09 10:01:00.000", true),
      incoming("m2", "t1", "2026-11-09 10:02:00.000", true),
      incoming("m3", "t2", "2026-11-09 10:03:00.000", true),
      incoming("m4", "t4", "2026-11-09 10:04:00.000", false),
    ], "t1");
    expect(next.map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("AC-UX-05 unread and where to land", () => {
  const list: ChannelList = {
    channels: [channel("general"), channel("launch"), channel("old", { archived: true })],
    most_recent: "launch",
    can_manage: true,
  };

  it("lands on the most recently active channel when the URL names none", () => {
    expect(initialChannel(null, list)).toBe("launch");
  });

  it("keeps the channel the URL names, archived or unknown ones included", () => {
    expect(initialChannel("general", list)).toBe("general");
    expect(initialChannel("old", list)).toBe("old");
    expect(initialChannel("gone", list)).toBe("gone");
  });

  it("falls back to the first live channel, or nothing", () => {
    expect(initialChannel(null, { channels: list.channels, most_recent: null })).toBe("general");
    expect(initialChannel(null, { channels: [channel("old", { archived: true })], most_recent: null })).toBeNull();
    expect(initialChannel(null, { channels: [] })).toBeNull();
  });

  it("shows the unread number, never a total", () => {
    expect(unreadLabel(0)).toBeNull();
    expect(unreadLabel(3)).toBe("3");
    expect(unreadLabel(250)).toBe("99+");
  });
});

describe("AC-UX-08 names", () => {
  it("names the person by display name, and the agent with who it acts for", () => {
    expect(authorOf(post("t1", "2026-11-09 10:00:00.000"))).toEqual({ name: "Walt Writer", onBehalfOf: null, agent: false });
    expect(
      authorOf(post("t1", "2026-11-09 10:00:00.000", { actor: { human: "Walt Writer", agent: "grok", label: "grok, on behalf of Walt Writer" } })),
    ).toEqual({ name: "grok", onBehalfOf: "Walt Writer", agent: true });
  });

  it("says how many replies a post has", () => {
    expect(replyLabel(0)).toBe("Reply");
    expect(replyLabel(1)).toBe("1 reply");
    expect(replyLabel(4)).toBe("4 replies");
  });
});

describe("AC-UX-11 promote title", () => {
  it("prefills from the first line, without markdown or mentions, at most 80 characters", () => {
    expect(promoteTitle("## Ship on **Friday**\n\nmore text")).toBe("Ship on Friday");
    expect(promoteTitle("\n\n- [ ] @walt@team.test freeze `main` before [[nodes/launch-plan]]")).toBe("freeze main before launch-plan");
    const long = promoteTitle("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith(" ")).toBe(false);
    expect(promoteTitle("   ")).toBe("");
  });
});

describe("AC-UX-13 archived channels", () => {
  it("lists archived channels apart from the live ones", () => {
    const { live, archived } = splitChannels([channel("a"), channel("b", { archived: true }), channel("c")]);
    expect(live.map((c) => c.name)).toEqual(["a", "c"]);
    expect(archived.map((c) => c.name)).toEqual(["b"]);
  });
});

describe("AC-UX-17 load more", () => {
  it("appends the next page and drops posts already shown", () => {
    const shown = [post("t3", "2026-11-09 10:03:00.000"), post("t2", "2026-11-09 10:02:00.000")];
    const next = appendPage(shown, [post("t2", "2026-11-09 10:02:00.000"), post("t1", "2026-11-09 10:01:00.000")]);
    expect(next.map((p) => p.id)).toEqual(["t3", "t2", "t1"]);
  });
});

describe("post-time mention outcome (toast)", () => {
  it("is silent when everything landed, and when the server returns nothing", () => {
    expect(mentionNotice([])).toBeNull();
    expect(mentionNotice(undefined)).toBeNull();
    const ok: PostedMention[] = [
      { name: "rita", kind: "person", display_name: "Rita Reader", notified: true },
      { name: "grok", kind: "agent", wake: "sent" },
      // Normal for an agent's own message or a rate-limited one.
      { name: "grok", kind: "agent", wake: "skipped" },
    ];
    expect(mentionNotice(ok)).toBeNull();
  });

  it("names who matched nobody and which agent has no webhook", () => {
    expect(mentionNotice([{ name: "Rita", kind: "nobody" }])).toBe("@Rita matched nobody in this nest.");
    expect(mentionNotice([{ name: "scout", kind: "agent", wake: "no_webhook" }])).toBe(
      "@scout has no wake-up webhook. It will see this when it next checks its work.",
    );
    expect(
      mentionNotice([
        { name: "Rita", kind: "nobody" },
        { name: "rita", kind: "nobody" },
        { name: "bo", kind: "nobody" },
        { name: "scout", kind: "agent", wake: "no_webhook" },
      ]),
    ).toBe("@Rita and @bo matched nobody in this nest. @scout has no wake-up webhook. It will see this when it next checks its work.");
  });
});
