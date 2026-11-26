/** AC-C3-08 (PO-1200): My Work's mentions grouped by nest, newest nest first. */
import { describe, expect, it } from "vitest";
import type { MentionItem } from "./api";
import { emptyPageStepBack, groupMentionsByNest, mentionPlace, mergeLiveWork } from "./my-work-inbox";

const m = (nest_id: string, thread_id: string, over: Partial<MentionItem> = {}): MentionItem => ({
  type: "mention",
  kind: "channel",
  nest_id,
  nest_name: `Nest ${nest_id}`,
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
  ...over,
});

describe("AC-C3-08 inbox groups", () => {
  it("groups by nest in order of first appearance, rows in the server's order", () => {
    const groups = groupMentionsByNest([m("b", "1"), m("a", "2"), m("b", "3")]);
    expect(groups.map((g) => [g.nest_name, g.rows.map((r) => r.thread_id)])).toEqual([
      ["Nest b", ["1", "3"]],
      ["Nest a", ["2"]],
    ]);
    expect(groupMentionsByNest([])).toEqual([]);
  });
  it("names the place: the channel, or the document", () => {
    expect(mentionPlace(m("a", "1"))).toBe("#ops");
    expect(mentionPlace(m("a", "1", { kind: "document", channel: null, title: "Launch Plan" }))).toBe("Launch Plan");
  });
  it("AC-C3-15 a mention in a direct or group message reads as one", () => {
    expect(mentionPlace(m("a", "1", { kind: "conversation", channel: null, title: "Conversation", node_id: "nodes/conversations/x" }))).toBe("a direct message");
  });
});

describe("po-1522 My Work background refresh", () => {
  const page = (offset: number) => ({ total: 60, limit: 50, offset, has_more: false });
  it("takes the fresh read, mentions included, on the first mentions page", () => {
    const prev = { items: [1, 2], mentions: [m("a", "1")], mentions_pagination: page(0) };
    const next = { items: [1], mentions: [m("a", "2")], mentions_pagination: page(0) };
    expect(mergeLiveWork(prev, next)).toEqual(next);
  });
  it("keeps a later mentions page where it is, and refreshes the rest", () => {
    const prev = { items: [1, 2], mentions: [m("a", "1")], mentions_pagination: page(50) };
    const next = { items: [1], mentions: [m("a", "2")], mentions_pagination: page(0) };
    expect(mergeLiveWork(prev, next)).toEqual({ ...prev, items: [1] });
  });
  it("steps back only from an emptied later page", () => {
    expect(emptyPageStepBack({ items: [], pagination: page(50) })).toBe(0);
    expect(emptyPageStepBack({ items: [1], pagination: page(50) })).toBeNull();
    expect(emptyPageStepBack({ items: [], pagination: page(0) })).toBeNull();
    expect(emptyPageStepBack({ items: [] })).toBeNull();
  });
});
