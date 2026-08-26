/**
 * Folder-scoped listing: `?folder=` returns ONE level, never the subtree, so
 * a nest with hundreds of documents costs only what the user expanded. The
 * census rides along so nest-wide UI (filters, stat tiles, the folder tree)
 * still describes the whole nest.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

describe("folder-scoped node listing", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: Awaited<ReturnType<typeof registerUser>>;
  let nestId: string;

  const list = (query: string) =>
    jsonRequest(app, "GET", `/nests/${nestId}/nodes${query}`, undefined, owner.apiKey);

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@folders.test");
    const { data } = await jsonRequest(
      app, "POST", "/nests", { name: "Folders" }, owner.apiKey,
    );
    nestId = data.nest.id;

    // Root: 2 docs. gtm: 1 doc + a subfolder holding 2. eng: 1 doc.
    const make = (title: string, folder?: string, tags: string[] = []) =>
      jsonRequest(
        app, "POST", `/nests/${nestId}/nodes`,
        { title, content: `# ${title}\n\nBody.`, tags, ...(folder ? { folder } : {}) },
        owner.apiKey,
      );
    await make("Root One", undefined, ["shared"]);
    await make("Root Two");
    await make("Gtm One", "gtm", ["shared"]);
    await make("Deal One", "gtm/deals");
    await make("Deal Two", "gtm/deals");
    await make("Eng One", "eng");
  });

  afterAll(() => env.cleanup());

  it("returns only the requested level, not the subtree", async () => {
    const root = await list("?folder=");
    expect(root.data.nodes.map((n: any) => n.id).sort()).toEqual([
      "nodes/root-one",
      "nodes/root-two",
    ]);

    const gtm = await list("?folder=gtm");
    expect(gtm.data.nodes.map((n: any) => n.id)).toEqual(["nodes/gtm/gtm-one"]);

    const deals = await list("?folder=gtm/deals");
    expect(deals.data.nodes.map((n: any) => n.id).sort()).toEqual([
      "nodes/gtm/deals/deal-one",
      "nodes/gtm/deals/deal-two",
    ]);

    // An empty folder path is a real level, not "unset" — the whole point.
    expect(root.data.nodes.length).toBeLessThan(6);
  });

  it("omitting folder still lists the whole nest", async () => {
    const { data } = await list("");
    expect(data.nodes.length).toBe(6);
  });

  it("never bundles the nest-wide census into a level fetch", async () => {
    // It describes the whole nest whatever level was asked for, so bundling it
    // recomputed the same answer on every folder expand.
    for (const q of ["", "?folder=", "?folder=gtm"]) {
      expect((await list(q)).data.census, `census bundled into ${q || "(none)"}`)
        .toBeUndefined();
    }
  });

  it("census describes the whole nest, from its own endpoint", async () => {
    const { status, data } = await jsonRequest(
      app, "GET", `/nests/${nestId}/census`, undefined, owner.apiKey,
    );
    expect(status).toBe(200);
    const census = data.census;

    expect(census.total).toBe(6);
    // Container folders appear too: `gtm` holds one doc but also `gtm/deals`.
    expect(census.folders).toEqual([
      { path: "eng", count: 1, total: 1 },
      { path: "gtm", count: 1, total: 3 },
      { path: "gtm/deals", count: 2, total: 2 },
    ]);
    // Census tag keys are the raw frontmatter tags, exactly as node rows
    // carry them — a '#'-stripped key here would not match the tag filter.
    expect(census.tags).toEqual({ "#shared": 2 });
    const rootRows = (await list("?folder=")).data.nodes;
    expect(rootRows.find((n: any) => n.id === "nodes/root-one").tags).toEqual([
      "#shared",
    ]);
    expect(census.types).toEqual({ document: 6 });
    expect(census.authors).toEqual(["owner@folders.test"]);
    expect(census.editedLast7d).toBe(6);
    expect(census.recent.length).toBe(3);
    expect(Object.values(census.statuses).reduce((a: any, b: any) => a + b, 0)).toBe(6);
  });
});
