/**
 * CU-wdqcpzzzut — "New folder" creates a folder with nothing in it: a real
 * directory in the vault carrying only the generated INDEX.md, instead of the
 * starter document it used to seed (which then counted as real content).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
  registerUser,
  settleSeals,
} from "./helpers";

describe("nodes: empty folders", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let dev: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    dev = await registerUser(app, "dev@acme.com", "Dev");
    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Folder Vault" },
      dev.apiKey,
    );
    nestId = data.nest.id;
  });

  afterAll(() => env.cleanup());

  it("creates a folder without creating a document", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/folders`,
      { folder: "GTM/Deals" },
      dev.apiKey,
    );
    expect(created.status).toBe(201);
    expect(created.data.folder).toBe("gtm/deals");

    // The folder is a directory in the vault, holding only its generated index.
    const dir = join(env.dataDir, "nests", nestId, "nodes", "gtm", "deals");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "INDEX.md"))).toBe(true);

    const folders = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/folders`,
      undefined,
      dev.apiKey,
    );
    const paths = folders.data.folders.map((f: any) => f.path);
    expect(paths).toContain("gtm/deals");
    // The parent level has to be expandable too.
    expect(paths).toContain("gtm");

    // Nothing was filed anywhere: the nest still has no documents.
    const nodes = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      dev.apiKey,
    );
    expect(nodes.data.nodes.length).toBe(0);
  });

  it("the census lists the empty folder at count 0", async () => {
    const census = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/census`,
      undefined,
      dev.apiKey,
    );
    const row = census.data.census.folders.find(
      (f: any) => f.path === "gtm/deals",
    );
    expect(row).toBeTruthy();
    expect(row.count).toBe(0);
    expect(census.data.census.total).toBe(0);
  });

  it("a document filed there keeps the folder listed, now with a count", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Pipeline", content: "body", folder: "gtm/deals" },
      dev.apiKey,
    );
    expect(created.status).toBe(201);

    const folders = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/folders`,
      undefined,
      dev.apiKey,
    );
    const row = folders.data.folders.find((f: any) => f.path === "gtm/deals");
    expect(row.count).toBe(1);
  });

  it("creating a folder that already exists leaves its content alone", async () => {
    const again = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/folders`,
      { folder: "gtm/deals" },
      dev.apiKey,
    );
    expect(again.status).toBe(201);

    // The document filed there in the previous test is untouched, and the
    // folder's generated index was not replaced by an empty one.
    const folders = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/folders`,
      undefined,
      dev.apiKey,
    );
    expect(
      folders.data.folders.find((f: any) => f.path === "gtm/deals").count,
    ).toBe(1);
    await settleSeals();
    const index = readFileSync(
      join(env.dataDir, "nests", nestId, "nodes", "gtm", "deals", "INDEX.md"),
      "utf-8",
    );
    expect(index).toContain("Pipeline");
  });

  it("deleting an empty folder removes it from the tree", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/folders`,
      { folder: "scratch" },
      dev.apiKey,
    );
    const del = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/delete-folder`,
      { folder: "scratch" },
      dev.apiKey,
    );
    expect(del.status).toBe(200);
    expect(del.data.deleted).toBe(0);
    expect(existsSync(join(env.dataDir, "nests", nestId, "nodes", "scratch"))).toBe(
      false,
    );

    const folders = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/folders`,
      undefined,
      dev.apiKey,
    );
    expect(folders.data.folders.map((f: any) => f.path)).not.toContain(
      "scratch",
    );
  });

  // CU-wdqcq02h4y — an editor asks for an empty folder to go; it used to 404.
  it("a deletion request on an empty folder is accepted", async () => {
    await jsonRequest(app, "POST", `/nests/${nestId}/folders`, { folder: "stale" }, dev.apiKey);
    const req = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/request-deletion`,
      { targetType: "folder", target: "stale", reason: "unused" },
      dev.apiKey,
    );
    expect(req.status).toBe(201);
    const missing = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/request-deletion`,
      { targetType: "folder", target: "never-made", reason: "x" },
      dev.apiKey,
    );
    expect(missing.status).toBe(404);
  });
});
