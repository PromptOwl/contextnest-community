/**
 * Document counts agree with the file list (CU-wdqcq01uym).
 *
 * Commenting on an artifact creates the derived `— Annotations` projection —
 * a real vault node that every user-facing listing deliberately hides, so
 * that leaving a comment doesn't grow the nest's document count. The listings
 * honour that; three counts didn't, and read one high per commented artifact,
 * permanently. A count that never corrects itself reads as a stale cache.
 *
 * Every surface that reports "how many documents" is pinned here against the
 * one that was already right (`/overview`).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { join } from "path";
import { writeFileSync } from "fs";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers.js";

let app: any;
let nestId: string;

/** Every "how many documents" answer the product gives, in one shot. */
async function counts(): Promise<{
  tile: number;
  banner: number;
  list: number;
  overview: number;
  stats: number;
  mcp: number | null;
  lastActivity: string | null;
}> {
  const tiles = await jsonRequest(app, "GET", "/nests");
  const tile = (tiles.data.nests as any[]).find((n) => n.id === nestId);
  const banner = (tiles.data.nests as any[]).reduce(
    (sum: number, n: any) => sum + n.document_count,
    0,
  );
  const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`);
  const overview = await jsonRequest(app, "GET", `/nests/${nestId}/overview`);
  const stats = await jsonRequest(app, "GET", "/stats");

  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "nest_index", arguments: {} },
    }),
  });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("application/json")
    ? await res.json()
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l: string) => l.startsWith("data: "))!
          .slice("data: ".length),
      );
  const mcpText = String(body?.result?.content?.[0]?.text ?? "");
  const mcpMatch = /- documents: (\d+)/.exec(mcpText);

  return {
    tile: tile?.document_count,
    banner,
    list: (list.data.nodes as any[]).length,
    overview: overview.data.total ?? overview.data.counts?.documents,
    stats: stats.data.documents,
    mcp: mcpMatch ? Number(mcpMatch[1]) : null,
    lastActivity: tile?.last_activity ?? null,
  };
}

beforeAll(async () => {
  setupTestEnv();
  app = await createTestApp("open");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Counted" });
  nestId = nest.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Doc One",
    content: "# one",
  });
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Doc Two",
    content: "# two",
  });
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "The Deck",
    content: "<h1>slide</h1>",
    type: "artifact",
  });
});

describe("document counts", () => {
  it("agree with each other before anything is commented on", async () => {
    const c = await counts();
    expect(c).toMatchObject({ tile: 3, list: 3, overview: 3, stats: 3, mcp: 3 });
    expect(c.banner).toBe(3);
  });

  it("do not move when an artifact is commented on", async () => {
    const before = await counts();
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/the-deck/annotations`,
      { body: "Slide needs a date." },
    );
    expect([200, 201]).toContain(res.status);

    const after = await counts();
    // The comment created a derived `— Annotations` node. It is a real node,
    // and the listings hide it; the counts must agree with the listings.
    expect(after.list).toBe(3);
    expect(after.tile).toBe(3);
    expect(after.banner).toBe(3);
    expect(after.overview).toBe(3);
    expect(after.stats).toBe(3);
    expect(after.mcp).toBe(3);

    // …but the nest is not untouched: a comment IS activity, and the card's
    // "recent activity" must still say so. This is why the count excludes the
    // derived node rather than the query excluding its rows.
    expect(after.lastActivity).toBeTruthy();
    if (before.lastActivity) {
      expect(
        after.lastActivity!.localeCompare(before.lastActivity),
      ).toBeGreaterThanOrEqual(0);
    }
  });

  it("drop by exactly one when a file is deleted", async () => {
    await jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/nodes/doc-two`);
    const c = await counts();
    expect(c).toMatchObject({ tile: 2, list: 2, overview: 2, stats: 2, mcp: 2 });
  });

  it("still counts a document whose own title ends in the derived suffix", async () => {
    // The exclusion is a suffix rule on the id, so a document a person
    // actually wrote with that shape of title is the one thing it could
    // wrongly hide. It is a real file: it counts, and it lists.
    const before = await counts();
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Meeting Annotations",
      content: "# notes",
    });
    const c = await counts();
    // Relative to what was there: a sibling above adds a file, and a test that
    // hardcodes a running total breaks on the next one added anywhere.
    expect(c.list).toBe(before.list + 1);
    expect(c.tile).toBe(before.tile + 1);
    expect(c.mcp).toBe(before.mcp! + 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Imported nests keep a file's case in its node id — the one place a REAL
// document can carry the derived suffix in a different case.
// ═══════════════════════════════════════════════════════════════════════════

describe("document counts on an imported nest", () => {
  let importedNest: string;

  beforeAll(async () => {
    const env = setupTestEnv();
    app = await createTestApp("open");
    const created = await jsonRequest(app, "POST", "/nests/import", {
      name: "Imported",
      files: [
        {
          path: "Notes.md",
          content: "---\ntitle: Notes\ntype: document\nstatus: published\n---\n\nbody\n",
        },
      ],
    });
    expect(created.status).toBe(201);
    importedNest = created.data.nest.id;
    nestId = importedNest;

    // The mixed-case id is written STRAIGHT INTO the vault, then REGISTERED.
    // Import used to preserve an uploaded path verbatim, but the engine
    // slugifies `files[]` paths now (PromptOwl/ContextNest#101, import
    // hygiene), which lowercases the id and collapses the `--` — destroying
    // the very case this test exists for. Registration is the other half of
    // import and takes its ids from disk discovery instead (flat-storage's
    // crawl: `ids.push(rel.replace(/\.md$/, ""))`), so the case survives. That
    // is also how this really happens: a folder sync, a CLI copy, or an
    // out-of-band write, picked up by the registration pass.
    writeFileSync(
      join(env.dataDir, "nests", importedNest, "Deck--Annotations.md"),
      "---\ntitle: Deck Annotations\ntype: document\nstatus: published\n---\n\nbody\n",
    );
    const registered = await jsonRequest(app, "POST", "/nests/import", {
      nestId: importedNest,
      finalize: true,
    });
    expect(registered.status).toBe(200);
  });

  it("counts a real document whose id ends in the suffix in another case", async () => {
    // The JS check is `endsWith("--annotations")` — case-sensitive — so
    // `Deck--Annotations` is NOT a projection, and every listing counts it.
    // SQLite's LIKE folds ASCII case and ignores COLLATE, so a LIKE-based
    // exclusion dropped this file from the card while every other surface
    // counted it — the same drift, from the other direction — and behaved
    // differently again on Postgres, whose LIKE is case-sensitive.
    const ids = await jsonRequest(app, "GET", `/nests/${importedNest}/nodes`);
    expect((ids.data.nodes as any[]).map((n) => n.id)).toContain(
      "Deck--Annotations",
    );

    const c = await counts();
    expect(c.list).toBe(2);
    expect(c.tile).toBe(2);
    expect(c.overview).toBe(2);
    expect(c.stats).toBe(2);
    expect(c.mcp).toBe(2);
  });
});
