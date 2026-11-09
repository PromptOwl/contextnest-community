/**
 * Channel nodes and the document reads (PO-1189): the listing reads leave
 * channel nodes out only while channels are on AND the caller is a person on
 * the nest. With the switch off nothing changes, and no extra request is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { channelForDocument, connectReadCache, createQueryClient, hidesChannelDocs, reads, setChannelsOn } from "./queries";

const NEST = "nest-1";
const channel = (name: string, extra: string[] = []) => ({
  id: `nodes/channels/${name}`,
  title: `#${name}`,
  type: "document",
  status: "published",
  tags: ["#channel", ...extra],
  updated_at: new Date().toISOString(),
});
const plan = { id: "nodes/launch-plan", title: "Launch Plan", type: "document", status: "published", tags: ["#gtm"], updated_at: "2026-11-01T10:00:00.000Z" };
const notes = { id: "nodes/channels/meeting-notes", title: "Meeting notes", type: "document", status: "published", tags: [], updated_at: "2026-11-02T10:00:00.000Z" };
const channels = [channel("ops"), channel("retired", ["#archived"])];

const census = () => ({
  census: {
    total: 4,
    folders: [{ path: "channels", count: 3, total: 3 }],
    tags: { "#channel": 2, "#archived": 1, "#gtm": 1 },
    types: { document: 4 },
    statuses: { published: 4 },
    aiReady: 4,
    authors: [],
    editedLast7d: 2,
    recent: [
      { id: "nodes/channels/ops", title: "#ops", type: "document", updated_at: channels[0].updated_at },
      { id: "nodes/channels/retired", title: "#retired", type: "document", updated_at: channels[1].updated_at },
    ],
  },
});

describe("document reads and channel nodes", () => {
  let qc: QueryClient;
  let member = true;
  let calls: string[] = [];

  beforeEach(() => {
    member = true;
    calls = [];
    qc = createQueryClient();
    connectReadCache(qc);
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      const path = String(url);
      calls.push(path);
      const body = path.endsWith(`/nests/${NEST}`)
        ? { nest: { id: NEST, name: "Team" }, permission: "read", member }
        : path.includes("/nodes?folder=channels")
          ? { count: 3, nodes: [...channels, notes] }
          : path.includes("/nodes?folder=")
            ? { count: 1, nodes: [plan] }
            : path.endsWith("/nodes")
              ? { count: 4, nodes: [...channels, notes, plan] }
              : path.endsWith("/census")
                ? census()
                : path.includes("/search?q=")
                  ? { query: "x", count: 2, nodes: [{ ...channels[0], snippet: "", nest_id: NEST, nest_name: "Team" }, { ...plan, snippet: "", nest_id: NEST, nest_name: "Team" }] }
                  : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) } as any;
    });
  });
  afterEach(() => setChannelsOn(false));

  it("with the switch off, nothing changes and nothing extra is fetched", async () => {
    const meta = await qc.fetchQuery(reads.nodesMeta(NEST));
    expect(meta.nodes).toHaveLength(4);
    const c = await qc.fetchQuery(reads.census(NEST));
    expect(c.census.total).toBe(4);
    expect(c.census.folders).toEqual([{ path: "channels", count: 3, total: 3 }]);
    expect(await hidesChannelDocs(NEST)).toBe(false);
    expect(await channelForDocument(NEST, "nodes/channels/ops")).toBeNull();
    // Only the two reads asked for: no nest read, no channel folder read.
    expect(calls).toHaveLength(2);
  });

  it("with the switch on, a person on the nest gets listings without channel nodes", async () => {
    setChannelsOn(true);
    const meta = await qc.fetchQuery(reads.nodesMeta(NEST));
    // The plain document filed under channels/ stays.
    expect(meta.nodes.map((n: { id: string }) => n.id)).toEqual(["nodes/channels/meeting-notes", "nodes/launch-plan"]);
    expect(meta.count).toBe(2);
    const level = await qc.fetchQuery(reads.folderNodes(NEST, "channels"));
    expect(level.nodes.map((n: { id: string }) => n.id)).toEqual(["nodes/channels/meeting-notes"]);
    const hits = await qc.fetchQuery(reads.globalSearch("x", 20));
    expect(hits.nodes.map((n) => n.id)).toEqual(["nodes/launch-plan"]);
    expect(hits.count).toBe(1);
  });

  it("the census loses the channels and its recent list is refilled with documents", async () => {
    setChannelsOn(true);
    const { census: c } = await qc.fetchQuery(reads.census(NEST));
    expect(c.total).toBe(2);
    expect(c.folders).toEqual([{ path: "channels", count: 1, total: 1 }]);
    expect(c.tags).toEqual({ "#gtm": 1 });
    expect(c.editedLast7d).toBe(0);
    expect(c.recent.map((r) => r.id)).toEqual(["nodes/channels/meeting-notes", "nodes/launch-plan"]);
  });

  it("someone who is not on the nest keeps the nodes as documents", async () => {
    setChannelsOn(true);
    member = false;
    expect((await qc.fetchQuery(reads.nodesMeta(NEST))).nodes).toHaveLength(4);
    expect((await qc.fetchQuery(reads.census(NEST))).census.total).toBe(4);
    expect(await channelForDocument(NEST, "nodes/channels/ops")).toBeNull();
  });

  it("a channel node addressed as a document goes to its channel; a plain document under channels/ does not", async () => {
    setChannelsOn(true);
    expect(await channelForDocument(NEST, "nodes/channels/ops")).toBe("ops");
    expect(await channelForDocument(NEST, "nodes/channels/meeting-notes")).toBeNull();
    expect(await channelForDocument(NEST, "nodes/launch-plan")).toBeNull();
  });

  it("the full listing with bodies keeps channel nodes, so a wikilink to a channel still resolves", async () => {
    setChannelsOn(true);
    (globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ count: 3, nodes: [...channels, plan] }) }) as any);
    expect((await qc.fetchQuery(reads.nodes(NEST))).nodes).toHaveLength(3);
  });

  it("switching channels on drops listings cached while they were off", async () => {
    await qc.fetchQuery(reads.nodesMeta(NEST));
    expect(qc.getQueryState(reads.nodesMeta(NEST).queryKey)?.isInvalidated).toBe(false);
    setChannelsOn(true);
    expect(qc.getQueryState(reads.nodesMeta(NEST).queryKey)?.isInvalidated).toBe(true);
  });
});
