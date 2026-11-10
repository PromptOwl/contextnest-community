/** AC-C3-08 (PO-1200): My Work's mentions grouped by nest, newest nest first. */
import { describe, expect, it } from "vitest";
import type { MentionItem } from "./api";
import { groupMentionsByNest, mentionPlace } from "./my-work-inbox";

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
});
