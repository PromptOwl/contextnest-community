import { describe, expect, it } from "vitest";
import {
  channelNameOfDoc,
  isChannelDoc,
  withoutChannelDocs,
  withoutChannelsInCensus,
  withoutChannelsInGraph,
  withoutChannelsInOverview,
} from "./channel-docs";

const doc = (id: string, tags: string[] = [], over: Record<string, unknown> = {}) => ({ id, title: id, type: "document", status: "published", tags, ...over });
const ops = doc("nodes/channels/ops", ["#channel"], { updated_at: "2026-11-09T10:00:00.000Z" });
const retired = doc("nodes/channels/retired", ["#channel", "#archived"], { updated_at: "2026-09-01T10:00:00.000Z" });
const plan = doc("nodes/launch-plan", ["#gtm"]);

describe("channel nodes are kept out of the document surfaces (PO-1189)", () => {
  it("knows a channel by the server's rule: a direct child of nodes/channels/ carrying #channel", () => {
    expect(isChannelDoc(ops)).toBe(true);
    expect(isChannelDoc(doc("nodes/channels/ops", ["channel"]))).toBe(true);
    expect(isChannelDoc(doc("nodes/channels/ops", ["#Channel"]))).toBe(true);
    // A document someone filed under channels/ is still a document.
    expect(isChannelDoc(doc("nodes/channels/meeting-notes", ["#notes"]))).toBe(false);
    expect(isChannelDoc(doc("nodes/channels/ops/sub", ["#channel"]))).toBe(false);
    expect(isChannelDoc(doc("nodes/other/ops", ["#channel"]))).toBe(false);
    expect(isChannelDoc(doc("nodes/channels/Ops", ["#channel"]))).toBe(false);
    expect(isChannelDoc({ id: "nodes/channels/ops" })).toBe(false);
  });

  it("names the channel a node id would be", () => {
    expect(channelNameOfDoc("nodes/channels/ops")).toBe("ops");
    expect(channelNameOfDoc("nodes/launch-plan")).toBeNull();
    expect(channelNameOfDoc("nodes/channels/ops/sub")).toBeNull();
  });

  it("drops channel nodes from a listing and fixes its count", () => {
    expect(withoutChannelDocs({ count: 3, nodes: [ops, plan, retired] })).toEqual({ count: 1, nodes: [plan] });
    const same = { count: 1, nodes: [plan] };
    expect(withoutChannelDocs(same)).toBe(same);
  });

  it("takes channels out of the census: totals, the folder, tags, types, statuses, recent", () => {
    const census = {
      total: 5,
      folders: [
        { path: "channels", count: 2, total: 2 },
        { path: "decisions", count: 1, total: 1 },
      ],
      tags: { "#channel": 2, "#archived": 1, "#gtm": 1 },
      types: { document: 5 },
      statuses: { published: 5 },
      aiReady: 5,
      authors: ["owner@team.test"],
      editedLast7d: 4,
      recent: [
        { id: "nodes/channels/ops", title: "#ops", type: "document", updated_at: "2026-11-09T10:00:00.000Z" },
        { id: "nodes/launch-plan", title: "Launch Plan", type: "document", updated_at: "2026-11-08T10:00:00.000Z" },
      ],
    };
    const out = withoutChannelsInCensus(census, [ops, retired], Date.parse("2026-11-09T12:00:00.000Z"));
    expect(out.total).toBe(3);
    expect(out.folders).toEqual([{ path: "decisions", count: 1, total: 1 }]);
    expect(out.tags).toEqual({ "#gtm": 1 });
    expect(out.types).toEqual({ document: 3 });
    expect(out.statuses).toEqual({ published: 3 });
    expect(out.aiReady).toBe(3);
    // Only #ops was edited in the last seven days.
    expect(out.editedLast7d).toBe(3);
    expect(out.recent.map((r) => r.id)).toEqual(["nodes/launch-plan"]);
    expect(out.authors).toEqual(["owner@team.test"]);
  });

  it("keeps the channels folder when a real document lives in it, with the right count", () => {
    const census = {
      total: 3,
      folders: [{ path: "channels", count: 3, total: 3 }],
      tags: { "#channel": 2 },
      types: { document: 3 },
      statuses: { published: 3 },
      authors: [],
      editedLast7d: 0,
      recent: [],
    };
    expect(withoutChannelsInCensus(census, [ops, retired], 0).folders).toEqual([{ path: "channels", count: 1, total: 1 }]);
  });

  it("leaves a census with no channels as it is", () => {
    const census = { total: 1, folders: [], tags: {}, types: { document: 1 }, statuses: { published: 1 }, authors: [], editedLast7d: 1, recent: [] };
    expect(withoutChannelsInCensus(census, [], 0)).toBe(census);
  });

  it("takes channels out of the overview and the graph", () => {
    const overview = { total: 3, types: { document: 3 }, tags: { "#channel": 2, "#archived": 1, "#gtm": 1 }, nodes: [ops, plan, retired] };
    expect(withoutChannelsInOverview(overview)).toEqual({ total: 1, types: { document: 1 }, tags: { "#gtm": 1 }, nodes: [plan] });
    const graph = {
      nodes: [doc("nodes/channels/ops", ["channel"]), doc("nodes/decisions/ship", ["decision"]), plan],
      links: [
        { source: "nodes/decisions/ship", target: "nodes/channels/ops" },
        { source: "nodes/decisions/ship", target: "nodes/launch-plan" },
      ],
      totalNodes: 3,
      truncated: false,
    };
    const g = withoutChannelsInGraph(graph);
    expect(g.nodes.map((n: { id: string }) => n.id)).toEqual(["nodes/decisions/ship", "nodes/launch-plan"]);
    expect(g.links).toEqual([{ source: "nodes/decisions/ship", target: "nodes/launch-plan" }]);
    expect(g.totalNodes).toBe(2);
  });
});
