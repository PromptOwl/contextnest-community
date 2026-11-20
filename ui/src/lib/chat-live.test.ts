/** AC-C3-12 (PO-1200): the C2 rules — container keys, live events, SSE frames, typing, presence, levels, unread. */
import { describe, expect, it } from "vitest";
import {
  applyPresence,
  chatEffects,
  containerKey,
  containerNodeId,
  heartbeatDue,
  keyOfContainerId,
  levelFor,
  listPollInterval,
  onlineSet,
  parseContainerKey,
  parseSse,
  pruneTyping,
  typingDue,
  typingLine,
  unreadForNest,
} from "./chat-live";

describe("AC-C3-12 containers", () => {
  it("names a channel by name and a conversation by ~uuid, both ways", () => {
    expect(containerKey({ kind: "channel", name: "ops" })).toBe("ops");
    expect(containerKey({ kind: "conversation", uuid: "abc" })).toBe("~abc");
    expect(parseContainerKey("ops")).toEqual({ kind: "channel", name: "ops" });
    expect(parseContainerKey("~abc")).toEqual({ kind: "conversation", uuid: "abc" });
    expect(parseContainerKey("~")).toBeNull();
    expect(parseContainerKey(null)).toBeNull();
  });
  it("maps to the node id the thread routes take, and back from an event", () => {
    expect(containerNodeId({ kind: "channel", name: "ops" })).toBe("nodes/channels/ops");
    expect(containerNodeId({ kind: "conversation", uuid: "abc" })).toBe("nodes/conversations/abc");
    expect(keyOfContainerId("nodes/conversations/abc")).toBe("~abc");
    expect(keyOfContainerId("nodes/channels/ops")).toBe("ops");
    expect(keyOfContainerId("nodes/plan")).toBeNull();
  });
});

describe("AC-C3-12 live events", () => {
  const ctx = { me: "me@x", openKey: "ops" };
  it("a new message: pull the open container, bump another, ignore my own elsewhere", () => {
    const msg = (conversation: string, author: string) => ({ event: "message.new" as const, data: { conversation, thread_id: "t", message_id: "m", reply: false, author, author_name: "A", agent: null } });
    expect(chatEffects(msg("nodes/channels/ops", "a@x"), ctx)).toEqual([{ kind: "pull" }]);
    expect(chatEffects(msg("nodes/channels/launch", "a@x"), ctx)).toEqual([{ kind: "bump", key: "launch" }]);
    expect(chatEffects(msg("nodes/channels/launch", "ME@x"), ctx)).toEqual([{ kind: "none" }]);
    expect(chatEffects(msg("nodes/conversations/abc", "a@x"), ctx)).toEqual([{ kind: "bump", key: "~abc" }]);
  });
  it("a change re-reads its thread; a mark from another tab zeroes; lists refetch", () => {
    expect(chatEffects({ event: "message.changed", data: { conversation: "nodes/channels/ops", thread_id: "t1", message_id: "m" } }, ctx)).toEqual([{ kind: "reread", key: "ops", thread: "t1" }]);
    expect(chatEffects({ event: "read.marked", data: { conversation: "nodes/channels/ops" } }, ctx)).toEqual([{ kind: "zero", key: "ops" }]);
    expect(chatEffects({ event: "channel.created", data: { conversation: "nodes/channels/x", name: "x" } }, ctx)).toEqual([{ kind: "refetch", what: "channels" }]);
    expect(chatEffects({ event: "conversation.created", data: { conversation: "nodes/conversations/abc", kind: "dm", by: "a@x" } }, ctx)).toEqual([{ kind: "refetch", what: "conversations" }]);
    expect(chatEffects({ event: "reset", data: { reason: "buffer" } }, ctx)).toEqual([{ kind: "reset" }]);
    expect(chatEffects({ event: "hello", data: { nest_id: "n", resume: false } }, ctx)).toEqual([{ kind: "none" }]);
  });
  it("typing is someone else's; membership refetches, and closes what I left", () => {
    // The server's shape (API.md): who is { email, name, agent }.
    const typing = (who: { email: string; name: string; agent: string | null }) => ({ event: "typing" as const, data: { conversation: "nodes/channels/ops", who } });
    expect(chatEffects(typing({ email: "w@x", name: "Walt", agent: null }), ctx)).toEqual([{ kind: "typing", key: "ops", who: "Walt" }]);
    expect(chatEffects(typing({ email: "w@x", name: "Walt", agent: "scout" }), ctx)).toEqual([{ kind: "typing", key: "ops", who: "@scout" }]);
    expect(chatEffects(typing({ email: "ME@x", name: "Me", agent: null }), ctx)).toEqual([{ kind: "none" }]);
    // My own agent typing is someone else as far as the line goes.
    expect(chatEffects(typing({ email: "me@x", name: "Me", agent: "scout" }), ctx)).toEqual([{ kind: "typing", key: "ops", who: "@scout" }]);
    expect(chatEffects({ event: "membership.changed", data: { conversation: "nodes/conversations/abc", action: "left", member: "me@x", by: "me@x" } }, ctx)).toEqual([
      { kind: "refetch", what: "members" },
      { kind: "closed", key: "~abc" },
    ]);
    expect(chatEffects({ event: "membership.changed", data: { conversation: "nodes/channels/ops", action: "added", member: "a@x", by: "b@x" } }, ctx)).toEqual([
      { kind: "refetch", what: "members" },
      { kind: "refetch", what: "channels" },
    ]);
  });
  it("polls slowly while the stream is up, at the usual pace otherwise", () => {
    expect(listPollInterval(true, 12_000)).toBe(60_000);
    expect(listPollInterval(false, 12_000)).toBe(12_000);
  });
});

describe("AC-C3-12 SSE frames", () => {
  it("parses whole frames, keeps a partial one, counts ping comments", () => {
    const r = parseSse('id: 1\nevent: hello\ndata: {"a":1}\n\n: ping\n\nevent: typing\ndata: {"b"');
    expect(r.frames).toEqual([{ id: "1", event: "hello", data: '{"a":1}' }]);
    expect(r.heartbeats).toBe(1);
    expect(r.rest).toBe('event: typing\ndata: {"b"');
    const next = parseSse(r.rest + ':2}\n\n');
    expect(next.frames).toEqual([{ id: null, event: "typing", data: '{"b":2}' }]);
    expect(next.rest).toBe("");
  });

  it("reads CRLF line endings", () => {
    const r = parseSse('id: 2\r\nevent: hello\r\ndata: {"a":1}\r\n\r\n');
    expect(r.frames).toEqual([{ id: "2", event: "hello", data: '{"a":1}' }]);
    expect(r.rest).toBe("");
  });
});

describe("AC-C3-12 typing and presence", () => {
  it("writes the typing line", () => {
    expect(typingLine([])).toBeNull();
    expect(typingLine(["Walt"])).toBe("Walt is typing…");
    expect(typingLine(["Walt", "Rita", "Walt"])).toBe("Walt and Rita are typing…");
    expect(typingLine(["A", "B", "C"])).toBe("3 people are typing…");
  });
  it("forgets a typist after five seconds, sends at most every three", () => {
    const m = new Map([["Walt", 1_000], ["Rita", 7_000]]);
    expect(pruneTyping(m, 7_500)).toEqual(["Rita"]);
    expect(typingDue(null, 10)).toBe(true);
    expect(typingDue(1_000, 4_000)).toBe(true);
    expect(typingDue(1_000, 2_000)).toBe(false);
  });
  it("heartbeats on connect and every 90 s, never from a hidden tab", () => {
    expect(heartbeatDue(null, 0, true)).toBe(true);
    expect(heartbeatDue(0, 89_000, true)).toBe(false);
    expect(heartbeatDue(0, 90_000, true)).toBe(true);
    expect(heartbeatDue(null, 0, false)).toBe(false);
  });
  it("tracks who is around from the list and from events", () => {
    const row = { email: "a@x", name: "A", agent: null, label: "A", status: null, last_seen: "2026-11-11T10:00:00Z" };
    expect(onlineSet([row]).has("a@x")).toBe(true);
    const after = applyPresence([row], { email: "b@x", agent: "grok", status: null, active: true }, new Date("2026-11-11T10:01:00Z"));
    expect(after.map((p) => p.label)).toEqual(["A", "grok, on behalf of b@x"]);
    expect(applyPresence(after, { email: "A@x", agent: null, status: null, active: false })).toHaveLength(1);
  });
});

describe("AC-C3-12 levels and unread", () => {
  it("the container's level, else the nest's, else the default", () => {
    const prefs = { default: "mentions" as const, nests: [{ nest_id: "n1", level: "none" as const, conversations: [{ conversation: "nodes/channels/ops", level: "all" as const }] }] };
    expect(levelFor(prefs, "n1", "nodes/channels/ops")).toBe("all");
    expect(levelFor(prefs, "n1", "nodes/channels/launch")).toBe("none");
    expect(levelFor(prefs, "n2", "nodes/channels/launch")).toBe("mentions");
    expect(levelFor(undefined, "n1", "x")).toBe("mentions");
  });
  it("the badge for one nest", () => {
    expect(unreadForNest({ total: 5, mentions: 1, nests: [{ nest_id: "n1", nest_name: "Team", unread: 3, mentions: 1, channels: [], conversations: [] }] }, "n1")).toBe(3);
    expect(unreadForNest(undefined, "n1")).toBe(0);
  });
});
