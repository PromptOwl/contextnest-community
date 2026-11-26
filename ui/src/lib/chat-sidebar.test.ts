/**
 * AC-C3-02 (PO-1200): the sidebar's order, filter and mention scope;
 * AC-C3-05: the nodes a thread touches; AC-C3-01: the chat's address.
 */
import { describe, expect, it } from "vitest";
import type { ChannelMessage, ChannelPost, ChannelSummary, MentionItem } from "./api";
import { chatHref, filterChannels, mentionsForNest, orderByActivity, threadNodes, unreadElsewhere } from "./chat-sidebar";

const ch = (name: string, over: Partial<ChannelSummary> = {}): ChannelSummary => ({
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

describe("AC-C3-02 channel order and filter", () => {
  it("newest activity first, empty channels last, ties by name", () => {
    const list = [ch("ops", { last_activity_at: "2026-11-09 10:00:00.000" }), ch("new"), ch("general", { last_activity_at: "2026-11-09 11:00:00.000" }), ch("alpha", { last_activity_at: "2026-11-09 10:00:00.000" })];
    expect(orderByActivity(list).map((c) => c.name)).toEqual(["general", "alpha", "ops", "new"]);
  });
  it("filters by every word in the name or purpose, ignoring a leading #", () => {
    const list = [ch("ops", { purpose: "Deploys and incidents" }), ch("general"), ch("launch", { purpose: "December launch" })];
    expect(filterChannels(list, "").map((c) => c.name)).toEqual(["ops", "general", "launch"]);
    expect(filterChannels(list, "#dec").map((c) => c.name)).toEqual(["launch"]);
    expect(filterChannels(list, "deploys incidents").map((c) => c.name)).toEqual(["ops"]);
    expect(filterChannels(list, "nothing")).toEqual([]);
  });
  it("counts unread outside the open channel", () => {
    expect(unreadElsewhere([ch("a", { unread: 3 }), ch("b", { unread: 2 })], "a")).toBe(2);
    expect(unreadElsewhere([ch("a", { unread: 3 })], null)).toBe(3);
  });
});

describe("AC-C3-02 mentions are this nest's only", () => {
  const m = (nest_id: string, thread_id: string): MentionItem => ({
    type: "mention",
    kind: "channel",
    nest_id,
    nest_name: nest_id,
    node_id: "nodes/channels/ops",
    title: "#ops",
    channel: "ops",
    thread_id,
    comment_id: "c",
    excerpt: "hi",
    author: "a@x",
    author_label: "A",
    agent: null,
    for_agent: null,
    mentioned_at: "2026-11-09 10:00:00.000",
  });
  it("keeps the server's order and drops other nests", () => {
    expect(mentionsForNest([m("n1", "t1"), m("n2", "t2"), m("n1", "t3")], "n1").map((x) => x.thread_id)).toEqual(["t1", "t3"]);
    expect(mentionsForNest(undefined, "n1")).toEqual([]);
  });
});

describe("AC-C3-05 the nodes a thread touches", () => {
  const card = (node_id: string, title: string, nest_id = "n1") =>
    ({ link: `[[${node_id}]]`, resolved: true as const, kind: "node" as const, nest_id, node_id, title, type: "document", stage: null, status: "published", version: 1, url: "/x" });
  const post: ChannelPost = {
    id: "t1",
    author: "a@x",
    actor: { human: "A", agent: null, label: "A" },
    body: "see [[nodes/plan]]",
    created_at: "2026-11-09 10:00:00.000",
    status: "open",
    reply_count: 1,
    last_reply_at: null,
    cards: [card("nodes/plan", "Launch Plan"), { link: "[[nodes/gone]]", resolved: false }],
    promoted: [{ kind: "decision", node_id: "nodes/decisions/ship", title: "Ship at $20" }],
  };
  const reply: ChannelMessage = { ...post, id: "r1", body: "and [[nodes/pricing]]", cards: [card("nodes/pricing", "Pricing Notes"), card("nodes/plan", "Launch Plan"), card("nodes/elsewhere", "Other", "n2")] };
  it("promoted nodes first, then links once each, unresolved and other nests left out", () => {
    expect(threadNodes(post, [reply], "n1")).toEqual([
      { id: "nodes/decisions/ship", title: "Ship at $20", via: "decision" },
      { id: "nodes/plan", title: "Launch Plan", via: "link" },
      { id: "nodes/pricing", title: "Pricing Notes", via: "link" },
    ]);
    expect(threadNodes(null)).toEqual([]);
  });
});

describe("AC-C3-01 the chat's address", () => {
  it("names the page, the channel, the thread and the message in that order", () => {
    expect(chatHref("n1", null)).toBe("/nest/n1/chat");
    expect(chatHref("n1", "ops")).toBe("/nest/n1/chat?channel=ops");
    expect(chatHref("n1", "ops", "t1")).toBe("/nest/n1/chat?channel=ops&thread=t1");
    expect(chatHref("n1", "ops", "t1", "m1")).toBe("/nest/n1/chat?channel=ops&thread=t1&message=m1");
    // A thread or message means nothing without a channel.
    expect(chatHref("n1", null, "t1", "m1")).toBe("/nest/n1/chat");
  });
});
