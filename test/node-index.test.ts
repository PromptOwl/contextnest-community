/**
 * node_index — the DB mirror of the on-disk document set.
 *
 * The listing, folder tree and census are served from this table instead of
 * walking the vault, so what matters is that it never disagrees with disk:
 * writes mirror through, out-of-band changes leave it flagged for rebuild, and
 * a rebuild reconciles it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";
import { getDb } from "../src/db/client.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let nestId: string;

/** The vault directory for a nest — where the engine keeps its markdown. */
function vaultPath(...segments: string[]): string {
  return join(env.dataDir, "nests", nestId, ...segments);
}

async function indexRows(): Promise<
  Array<{ node_id: string; folder: string; title: string; type: string }>
> {
  return (await getDb().all(
    "SELECT node_id, folder, title, type FROM node_index WHERE nest_id = ? ORDER BY node_id",
    [nestId],
  )) as any;
}

async function syncedAt(): Promise<string | null> {
  const row = (await getDb().get(
    "SELECT index_synced_at FROM nests WHERE id = ?",
    [nestId],
  )) as { index_synced_at: string | null };
  return row.index_synced_at;
}

async function createNode(
  title: string,
  opts: { folder?: string; tags?: string[]; content?: string } = {},
) {
  const res = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    {
      title,
      content: opts.content ?? `# ${title}\n\nbody of ${title}`,
      ...(opts.folder ? { folder: opts.folder } : {}),
      ...(opts.tags ? { tags: opts.tags } : {}),
    },
    owner.apiKey,
  );
  expect(res.status).toBe(201);
  return res.data.node;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@example.com");
  const nest = await jsonRequest(
    app,
    "POST",
    "/nests",
    { name: "Indexed" },
    owner.apiKey,
  );
  nestId = nest.data.nest.id;

  await createNode("Root Doc");
  await createNode("Alpha One", { folder: "alpha", tags: ["gtm"] });
  await createNode("Alpha Two", { folder: "alpha", tags: ["gtm", "pricing"] });
  await createNode("Deep One", { folder: "alpha/deep" });
  await createNode("Beta One", { folder: "beta", tags: ["pricing"] });
});

afterAll(async () => {
  await env.cleanup();
});

describe("node_index — write-through", () => {
  it("mirrors every created document, with its folder", async () => {
    const rows = await indexRows();
    expect(rows.map((r) => r.node_id)).toEqual([
      "nodes/alpha/alpha-one",
      "nodes/alpha/alpha-two",
      "nodes/alpha/deep/deep-one",
      "nodes/beta/beta-one",
      "nodes/root-doc",
    ]);
    const deep = rows.find((r) => r.node_id === "nodes/alpha/deep/deep-one")!;
    // Folder is the community path — the `nodes/` storage root is not a folder.
    expect(deep.folder).toBe("alpha/deep");
    expect(rows.find((r) => r.node_id === "nodes/root-doc")!.folder).toBe("");
  });

  it("follows an edit without any manual reindex", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${encodeURIComponent("nodes/beta/beta-one")}`,
      { title: "Beta Renamed", tags: ["pricing", "urgent"] },
      owner.apiKey,
    );
    expect(res.status).toBe(200);

    const row = (await indexRows()).find(
      (r) => r.node_id === "nodes/beta/beta-one",
    )!;
    expect(row.title).toBe("Beta Renamed");

    // And the census — which is built entirely from these rows — agrees.
    const census = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/census`,
      undefined,
      owner.apiKey,
    );
    expect(census.data.census.tags["#urgent"]).toBe(1);
  });

  it("drops the row when a document is deleted", async () => {
    await createNode("Doomed", { folder: "beta" });
    expect(
      (await indexRows()).some((r) => r.node_id === "nodes/beta/doomed"),
    ).toBe(true);

    const del = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/nodes/${encodeURIComponent("nodes/beta/doomed")}`,
      undefined,
      owner.apiKey,
    );
    expect(del.status).toBe(200);
    expect(
      (await indexRows()).some((r) => r.node_id === "nodes/beta/doomed"),
    ).toBe(false);
  });

  it("repoints the row when a document moves", async () => {
    await createNode("Mover", { folder: "alpha" });
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${encodeURIComponent("nodes/alpha/mover")}/move`,
      { folder: "beta" },
      owner.apiKey,
    );
    expect(res.status).toBe(200);

    const rows = await indexRows();
    expect(rows.some((r) => r.node_id === "nodes/alpha/mover")).toBe(false);
    const moved = rows.find((r) => r.node_id === "nodes/beta/mover");
    expect(moved).toBeDefined();
    expect(moved!.folder).toBe("beta");
  });
});

describe("node_index — reads served from it", () => {
  it("census counts folders, tags and types without reading the vault", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/census`,
      undefined,
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    const census = res.data.census;

    const alpha = census.folders.find((f: any) => f.path === "alpha")!;
    // Two documents directly in alpha/, plus the one in alpha/deep.
    expect(alpha.count).toBe(2);
    expect(alpha.total).toBe(3);
    // A folder that only holds subfolders still has to be expandable, so the
    // ancestor row exists even though no document sits in it.
    expect(census.folders.some((f: any) => f.path === "alpha/deep")).toBe(true);
    expect(census.tags["#gtm"]).toBe(2);
  });

  it("the folder tree agrees with the census", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/folders`,
      undefined,
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    const paths = res.data.folders.map((f: any) => f.path).sort();
    expect(paths).toEqual(["alpha", "alpha/deep", "beta"]);
  });

  it("lists one folder level, without bodies", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes?folder=alpha`,
      undefined,
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.nodes.map((n: any) => n.id).sort()).toEqual([
      "nodes/alpha/alpha-one",
      "nodes/alpha/alpha-two",
    ]);
    // Metadata is all the tree renders; a body would cost a file read per row.
    expect(res.data.nodes[0].title).toBeTruthy();
    expect(res.data.nodes.every((n: any) => n.content === "")).toBe(true);
  });

  it("serves bodies on request", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes?folder=alpha&content=1`,
      undefined,
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    const one = res.data.nodes.find(
      (n: any) => n.id === "nodes/alpha/alpha-one",
    );
    expect(one.content).toContain("body of Alpha One");
  });

  it("still honours type and tag filters", async () => {
    const byTag = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes?tag=gtm`,
      undefined,
      owner.apiKey,
    );
    expect(byTag.data.nodes.map((n: any) => n.id).sort()).toEqual([
      "nodes/alpha/alpha-one",
      "nodes/alpha/alpha-two",
    ]);

    // A `#`-less tag and a `#`-prefixed one mean the same thing — the engine's
    // own filter decides that, here as before.
    const hashed = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes?tag=%23gtm`,
      undefined,
      owner.apiKey,
    );
    expect(hashed.data.nodes.length).toBe(2);
  });
});

describe("node_index — staying in sync with disk", () => {
  it("rebuilds on read after the nest is flagged stale", async () => {
    // A document written straight to the vault, the way an external edit or a
    // second instance's write would arrive.
    mkdirSync(vaultPath("nodes", "beta"), { recursive: true });
    writeFileSync(
      vaultPath("nodes", "beta", "smuggled.md"),
      `---\ntitle: Smuggled\ntype: document\nstatus: draft\ntags:\n  - pricing\n---\n\nfrom outside\n`,
      "utf-8",
    );

    // Nothing has told the index, so it does not know about it yet.
    expect(
      (await indexRows()).some((r) => r.node_id === "nodes/beta/smuggled"),
    ).toBe(false);

    await getDb().run("UPDATE nests SET index_synced_at = NULL WHERE id = ?", [
      nestId,
    ]);

    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes?folder=beta`,
      undefined,
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.nodes.some((n: any) => n.id === "nodes/beta/smuggled")).toBe(
      true,
    );
    // Rebuilt and re-stamped, so the next read costs nothing.
    expect(await syncedAt()).not.toBeNull();
  });

  it("a rebuild drops rows for documents that left disk", async () => {
    rmSync(vaultPath("nodes", "beta", "smuggled.md"));
    await getDb().run("UPDATE nests SET index_synced_at = NULL WHERE id = ?", [
      nestId,
    ]);

    await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/census`,
      undefined,
      owner.apiKey,
    );
    expect(
      (await indexRows()).some((r) => r.node_id === "nodes/beta/smuggled"),
    ).toBe(false);
  });

  it("does not lose a write that lands while a rebuild is crawling", async () => {
    // The rebuild replaces every row for the nest with the set it read from
    // disk. A create racing it would be wiped by that swap — and the stamp
    // would then declare the mirror fresh, hiding a document that exists.
    await getDb().run("UPDATE nests SET index_synced_at = NULL WHERE id = ?", [
      nestId,
    ]);
    const rebuilding = jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/census`,
      undefined,
      owner.apiKey,
    );
    const racer = await createNode("Racer", { folder: "beta" });
    await rebuilding;

    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes?folder=beta`,
      undefined,
      owner.apiKey,
    );
    expect(list.data.nodes.some((n: any) => n.id === racer.id)).toBe(true);
  });

  it("POST /reindex restores an index emptied behind its back", async () => {
    await getDb().run("DELETE FROM node_index WHERE nest_id = ?", [nestId]);
    expect(await indexRows()).toHaveLength(0);

    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/reindex`,
      {},
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.indexed).toBeGreaterThan(0);
    expect((await indexRows()).length).toBe(res.data.indexed);
  });

  it("refuses a reindex from a caller without write access", async () => {
    const stranger = await registerUser(app, "stranger@example.com");
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/reindex`,
      {},
      stranger.apiKey,
    );
    expect([403, 404]).toContain(res.status);
  });
});
