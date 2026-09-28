/**
 * An imported nest whose documents all live in folders — the shape that broke
 * the Documents tab.
 *
 * Two things differ from a nest created in-app: ids carry no `nodes/` storage
 * prefix (the folder was copied in as-is), and the root level legitimately
 * holds zero documents. Lazy loading has to cope with both, or the tab shows
 * an empty "drag files here" dropzone over a nest that plainly has content.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

const mdFile = (path: string, title: string) => ({
  path,
  content: `---\ntitle: ${title}\ntype: document\nstatus: published\n---\n\nbody\n`,
});

describe("imported nest — documents tab data", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: Awaited<ReturnType<typeof registerUser>>;
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@imported.test");

    // Every document sits inside a folder — nothing at the root at all.
    const { status, data } = await jsonRequest(
      app, "POST", "/nests/import",
      {
        name: "distill market",
        files: [
          mdFile("market/00-orchestrator.md", "00 orchestrator"),
          mdFile("market/method/method-one.md", "Method One"),
          mdFile("market/recipes/recipe-market-sizing.md", "Recipe Market Sizing"),
          mdFile("market/recipes/recipe-competitive.md", "Recipe Competitive"),
          mdFile("market/spine/spine-one.md", "Spine One"),
          mdFile("market/spine/spine-two.md", "Spine Two"),
        ],
      },
      owner.apiKey,
    );
    expect(status).toBe(201);
    expect(data.nest.is_imported).toBe(1);
    nestId = data.nest.id;
  });

  afterAll(() => env.cleanup());

  it("the whole-nest listing still returns every document", async () => {
    const { data } = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes`, undefined, owner.apiKey,
    );
    expect(data.nodes.length).toBe(6);
    // No `nodes/` prefix: the imported folder's own layout is the id.
    expect(data.nodes.every((n: any) => !n.id.startsWith("nodes/"))).toBe(true);
  });

  it("the census reports the folders the tab renders its tree from", async () => {
    const { data } = await jsonRequest(
      app, "GET", `/nests/${nestId}/census`, undefined, owner.apiKey,
    );
    expect(data.census.total).toBe(6);
    expect(data.census.folders.map((f: any) => f.path).sort()).toEqual([
      "market",
      "market/method",
      "market/recipes",
      "market/spine",
    ]);
  });

  it("the folders endpoint sees the imported layout, not a nodes/ root", async () => {
    const { data } = await jsonRequest(
      app, "GET", `/nests/${nestId}/folders`, undefined, owner.apiKey,
    );
    expect(data.folders.map((f: any) => f.path).sort()).toEqual([
      "market",
      "market/method",
      "market/recipes",
      "market/spine",
    ]);
  });

  it("expanding a folder returns that folder's own documents", async () => {
    const level = async (folder: string) => {
      const { data } = await jsonRequest(
        app, "GET",
        `/nests/${nestId}/nodes?folder=${encodeURIComponent(folder)}`,
        undefined, owner.apiKey,
      );
      return data.nodes.map((n: any) => n.id).sort();
    };
    // The root level is empty here — that is correct, and is exactly why the
    // tab must render the folder tree rather than an empty state.
    expect(await level("")).toEqual([]);
    expect(await level("market")).toEqual(["market/00-orchestrator"]);
    expect(await level("market/recipes")).toEqual([
      "market/recipes/recipe-competitive",
      "market/recipes/recipe-market-sizing",
    ]);
  });
});

describe("imported nest — uploads dir is not a folder", () => {
  let env: ReturnType<typeof setupTestEnv>;
  afterAll(() => env.cleanup());

  it("keeps <nest>/assets out of the census and the folder tree", async () => {
    env = setupTestEnv();
    const app = await createTestApp("key");
    const owner = await registerUser(app, "owner@assets.test");
    const { data } = await jsonRequest(
      app, "POST", "/nests/import",
      { name: "flat", files: [mdFile("guides/one.md", "One")] },
      owner.apiKey,
    );
    const nestId = data.nest.id;
    // A flat nest's root is the nest dir, so uploads land beside its folders.
    mkdirSync(join(env.dataDir, "nests", nestId, "assets"), { recursive: true });

    const census = await jsonRequest(app, "GET", `/nests/${nestId}/census`, undefined, owner.apiKey);
    const folders = await jsonRequest(app, "GET", `/nests/${nestId}/folders`, undefined, owner.apiKey);
    expect(census.data.census.folders.map((f: any) => f.path)).toEqual(["guides"]);
    expect(folders.data.folders.map((f: any) => f.path)).toEqual(["guides"]);
  });
});
