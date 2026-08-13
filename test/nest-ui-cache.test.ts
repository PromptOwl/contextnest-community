import { describe, it, expect, beforeEach, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import * as api from "../ui/src/lib/api";
import { createQueryClient, connectReadCache, reads } from "../ui/src/lib/queries";

/**
 * Nest UI read caching — the structural reads hit on every navigation
 * (listNodes, listNests, getNest, getNestSettings) must serve from the shared
 * client cache instead of re-fetching, and any mutation must invalidate that
 * nest's entries so approval/edit state is never stale.
 *
 * These exercise the query layer through the same `connectReadCache` bridge the
 * app shell wires up, so the api-module invalidation hooks are under test too.
 */

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as any;

const errJson = (status: number, body: unknown = { error: "nope" }) =>
  ({ ok: false, status, text: async () => JSON.stringify(body) }) as any;

const getListCalls = (spy: any, path: string) =>
  spy.mock.calls.filter(
    (c: any[]) =>
      String(c[0]).endsWith(path) && (!c[1] || c[1].method === undefined),
  );

describe("nest UI read caching @unit", () => {
  let fetchSpy: any;
  let qc: QueryClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    qc = createQueryClient();
    connectReadCache(qc);
    fetchSpy = vi.fn(async () => okJson({ count: 0, nodes: [], node: {} }));
    (globalThis as any).fetch = fetchSpy;
  });

  it("serves a repeated listNodes from cache — one network call", async () => {
    await qc.fetchQuery(reads.nodes("nest-1"));
    await qc.fetchQuery(reads.nodes("nest-1"));
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(1);
  });

  it("refetches after a mutation invalidates that nest's cache", async () => {
    await qc.fetchQuery(reads.nodes("nest-1")); // fetch #1
    await api.createNode("nest-1", { title: "t", content: "c" }); // invalidate
    await qc.fetchQuery(reads.nodes("nest-1")); // fetch #2
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(2);
  });

  it("scopes the cache per nest — different nests don't collide", async () => {
    await qc.fetchQuery(reads.nodes("nest-1"));
    await qc.fetchQuery(reads.nodes("nest-2"));
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(1);
    expect(getListCalls(fetchSpy, "/nests/nest-2/nodes")).toHaveLength(1);
  });

  it("invalidating one nest leaves a sibling whose id shares its prefix alone", async () => {
    await qc.fetchQuery(reads.nodes("nest-1"));
    await qc.fetchQuery(reads.nodes("nest-12"));
    await api.createNode("nest-1", { title: "t", content: "c" });

    await qc.fetchQuery(reads.nodes("nest-1")); // stale → refetch
    await qc.fetchQuery(reads.nodes("nest-12")); // untouched → cached
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(2);
    expect(getListCalls(fetchSpy, "/nests/nest-12/nodes")).toHaveLength(1);
  });

  it("deduplicates two simultaneous reads of the same data into one request", async () => {
    const [a, b] = await Promise.all([
      qc.fetchQuery(reads.nodes("nest-1")),
      qc.fetchQuery(reads.nodes("nest-1")),
    ]);
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it("busts the nests list on a node-level mutation — its rows carry document_count", async () => {
    fetchSpy = vi.fn(async () => okJson({ nests: [], node: {}, count: 0, nodes: [] }));
    (globalThis as any).fetch = fetchSpy;

    await qc.fetchQuery(reads.nestList());
    await api.createNode("nest-1", { title: "t", content: "c" });
    await qc.fetchQuery(reads.nestList());
    expect(getListCalls(fetchSpy, "/nests")).toHaveLength(2);
  });

  it("refetches the nests list after syncing an unsynced folder", async () => {
    fetchSpy = vi.fn(async () => okJson({ nests: [], nest: {}, documents: 0 }));
    (globalThis as any).fetch = fetchSpy;

    await qc.fetchQuery(reads.nestList());
    await api.syncUnsyncedFolder("folder-a"); // bypasses the /nests/{id} hook
    await qc.fetchQuery(reads.nestList());
    expect(getListCalls(fetchSpy, "/nests")).toHaveLength(2);
  });

  it("drops every entry on an identity change — no cross-user leakage", async () => {
    await qc.fetchQuery(reads.nodes("nest-1"));
    await qc.fetchQuery(reads.nestList());

    api.invalidateNestReads(); // what login / logout / user switch calls

    expect(qc.getQueryData(reads.nodes("nest-1").queryKey)).toBeUndefined();
    expect(qc.getQueryData(reads.nestList().queryKey)).toBeUndefined();
  });

  it("does not cache a failed read as if it were data", async () => {
    fetchSpy = vi.fn(async () => errJson(500));
    (globalThis as any).fetch = fetchSpy;

    await expect(qc.fetchQuery(reads.nodes("nest-1"))).rejects.toThrow();
    expect(qc.getQueryData(reads.nodes("nest-1").queryKey)).toBeUndefined();
  });

  it("does not retry a 403 — it is an answer, not a blip", async () => {
    fetchSpy = vi.fn(async () => errJson(403));
    (globalThis as any).fetch = fetchSpy;

    await expect(qc.fetchQuery(reads.nodes("nest-1"))).rejects.toThrow();
    expect(getListCalls(fetchSpy, "/nests/nest-1/nodes")).toHaveLength(1);
  });
});

/**
 * Editor safety. A document body is the one read that must never be served
 * from cache to someone about to edit it — an edit has to start from server
 * truth, or the save races a change it never saw. That guarantee is the
 * zero staleness on the body query, so it is asserted directly: everything
 * else in the editor (loading once per document, snapshotting, restoring an
 * unsaved draft only when its baseVersion still matches) sits on top of it.
 */
describe("document body freshness @unit", () => {
  let qc: QueryClient;
  let fetchSpy: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    qc = createQueryClient();
    connectReadCache(qc);
    fetchSpy = vi.fn(async () => okJson({ node: { content: "server" } }));
    (globalThis as any).fetch = fetchSpy;
  });

  it("re-reads the body every time — never serves a cached one to an edit", async () => {
    await qc.fetchQuery(reads.node("n1", "nodes/doc"));
    await qc.fetchQuery(reads.node("n1", "nodes/doc"));
    expect(getListCalls(fetchSpy, "/nests/n1/nodes/nodes/doc")).toHaveLength(2);
  });

  it("lets a read-only viewer opt into a cached body by widening staleness", async () => {
    // What the wiki-link hover preview does: it renders an excerpt, never an
    // editable copy, so re-hovering should not refetch.
    const preview = { ...reads.node("n1", "nodes/doc"), staleTime: 30_000 };
    await qc.fetchQuery(preview);
    await qc.fetchQuery(preview);
    expect(getListCalls(fetchSpy, "/nests/n1/nodes/nodes/doc")).toHaveLength(1);
  });
});

/**
 * A write must invalidate what it changed and leave the rest alone. Over-broad
 * invalidation is what made NestView re-fetch all nine of its reads whenever
 * any one document was touched; under-broad invalidation shows the user a value
 * the server no longer holds, which is worse. Both directions are asserted.
 */
describe("write invalidation scope @unit", () => {
  let qc: QueryClient;
  const isStale = (key: readonly unknown[]) =>
    qc.getQueryState(key)?.isInvalidated === true;

  beforeEach(async () => {
    vi.restoreAllMocks();
    qc = createQueryClient();
    connectReadCache(qc);
    // One body covering every shape the seeded reads unwrap — some return the
    // envelope, some return a field off it (listConnectors → r.connectors).
    (globalThis as any).fetch = vi.fn(async () =>
      okJson({
        nodes: [],
        nests: [],
        stewards: [],
        connectors: [],
        requests: [],
        total: 0,
        node: {},
        counts: {},
      }),
    );
    // Seed every entry a nest write might touch.
    await Promise.all([
      qc.fetchQuery(reads.nodes("n1")),
      qc.fetchQuery(reads.stewards("n1")),
      qc.fetchQuery(reads.connectors("n1")),
      qc.fetchQuery(reads.settings("n1")),
      qc.fetchQuery(reads.commentCounts("n1")),
      qc.fetchQuery(reads.reviewQueue("n1")),
      qc.fetchQuery(reads.node("n1", "nodes/deep/doc")),
    ]);
  });

  it("editing a document leaves that nest's stewards and connectors alone", async () => {
    await api.updateNode("n1", "nodes/deep/doc", { content: "x" });

    expect(isStale(reads.nodes("n1").queryKey)).toBe(true);
    expect(isStale(reads.node("n1", "nodes/deep/doc").queryKey)).toBe(true);
    expect(isStale(reads.stewards("n1").queryKey)).toBe(false);
    expect(isStale(reads.connectors("n1").queryKey)).toBe(false);
    expect(isStale(reads.settings("n1").queryKey)).toBe(false);
  });

  it("resolves a slash-bearing document id from the path, not the first segment", async () => {
    await api.createComment("n1", "nodes/deep/doc", { body: "hi" });

    // The id is "nodes/deep/doc" — a naive match would stop at "nodes".
    expect(isStale(reads.node("n1", "nodes/deep/doc").queryKey)).toBe(true);
    expect(isStale(reads.commentCounts("n1").queryKey)).toBe(true);
    expect(isStale(reads.stewards("n1").queryKey)).toBe(false);
  });

  it("approving a document invalidates the review queue it just left", async () => {
    await api.approveNode("n1", "nodes/deep/doc");

    expect(isStale(reads.reviewQueue("n1").queryKey)).toBe(true);
    expect(isStale(reads.nodes("n1").queryKey)).toBe(true);
    expect(isStale(reads.connectors("n1").queryKey)).toBe(false);
  });

  it("a settings write touches settings only", async () => {
    await api.updateNestSettings("n1", { stewardship_enabled: true });

    expect(isStale(reads.settings("n1").queryKey)).toBe(true);
    expect(isStale(reads.nodes("n1").queryKey)).toBe(false);
    expect(isStale(reads.stewards("n1").queryKey)).toBe(false);
  });

  it("a visibility change invalidates the nest subtree — it changes who sees what", async () => {
    await api.setNestVisibility("n1", "public");

    expect(isStale(reads.nodes("n1").queryKey)).toBe(true);
    expect(isStale(reads.stewards("n1").queryKey)).toBe(true);
  });

  it("invalidates a document's body when it is saved", async () => {
    await api.updateNode("n1", "nodes/deep/doc", { content: "x" });
    expect(isStale(reads.node("n1", "nodes/deep/doc").queryKey)).toBe(true);
  });

  it("falls back to the whole nest for a path it does not recognise", async () => {
    // /nests/:id/context is not in the scope table. Better to over-refetch than
    // to leave an unrecognised write serving a value the server no longer holds.
    await api.queryContext("n1", "#tag", 1);

    expect(isStale(reads.nodes("n1").queryKey)).toBe(true);
    expect(isStale(reads.stewards("n1").queryKey)).toBe(true);
    expect(isStale(reads.connectors("n1").queryKey)).toBe(true);
  });
});
