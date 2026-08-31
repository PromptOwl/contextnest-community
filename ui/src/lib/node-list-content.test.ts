/**
 * The nest-wide node listing must carry document bodies; the per-folder one
 * must not.
 *
 * Wiki-link analysis (backlinks, unlinked mentions, stale alias links, related
 * docs, the orphan/broken-link panel) reads `[[targets]]` out of every
 * document's body, and the nest-wide listing is where it gets them. Drop the
 * bodies and every one of those degrades to EMPTY — no error, no failed
 * request, just a permanently blank panel that no other test would notice.
 *
 * The folder-scoped listing is the opposite case: it backs the document tree,
 * renders no body, and is the request path the node index exists to keep off
 * the filesystem. Bodies there put the per-file reads straight back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listNodes, listFolderNodes } from "./api";

let urls: string[];

beforeEach(() => {
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ count: 0, nodes: [] }),
      } as any;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("node listing bodies", () => {
  it("asks for content on the nest-wide listing", async () => {
    await listNodes("nest-1");
    expect(urls[0]).toContain("/nests/nest-1/nodes");
    expect(urls[0]).toContain("content=1");
  });

  it("does NOT ask for content on a folder level", async () => {
    await listFolderNodes("nest-1", "reports");
    expect(urls[0]).toContain("folder=reports");
    expect(urls[0]).not.toContain("content=1");
  });

  it("keeps the nest root folder body-free too", async () => {
    await listFolderNodes("nest-1", "");
    expect(urls[0]).not.toContain("content=1");
  });
});
