/**
 * GET /nests/:id/folders — the vault's shape with none of its content, for
 * callers that need a navigable tree and not the documents in it.
 *
 * Runs against whichever engine is pinned: with `listFolders` available it
 * reads directory entries only, without it the same shape is derived from the
 * document ids. Both paths must answer identically, or bumping the engine
 * would quietly change the tree.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

describe("folder listing endpoint", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: Awaited<ReturnType<typeof registerUser>>;
  let nestId: string;

  const folders = async (query = "", apiKey = owner.apiKey) =>
    jsonRequest(app, "GET", `/nests/${nestId}/folders${query}`, undefined, apiKey);

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@folders2.test");
    const { data } = await jsonRequest(
      app, "POST", "/nests", { name: "Shape" }, owner.apiKey,
    );
    nestId = data.nest.id;

    const make = (title: string, folder?: string) =>
      jsonRequest(
        app, "POST", `/nests/${nestId}/nodes`,
        { title, content: `# ${title}\n\nBody.`, ...(folder ? { folder } : {}) },
        owner.apiKey,
      );
    await make("Root One");
    await make("Gtm One", "gtm");
    await make("Deal One", "gtm/deals");
    await make("Deal Two", "gtm/deals");
    await make("Eng One", "eng");
  });

  afterAll(() => env.cleanup());

  it("returns the whole tree with direct and subtree counts", async () => {
    const { data } = await folders();
    expect(data.folders).toEqual([
      { path: "eng", count: 1, total: 1 },
      // `gtm` holds one document itself and two more below it.
      { path: "gtm", count: 1, total: 3 },
      { path: "gtm/deals", count: 2, total: 2 },
    ]);
  });

  it("scopes to one folder, and to one level", async () => {
    expect((await folders("?folder=gtm")).data.folders).toEqual([
      { path: "gtm/deals", count: 2, total: 2 },
    ]);

    // Immediate children of the nest root — `gtm/deals` is a level too deep.
    expect((await folders("?recursive=0")).data.folders).toEqual([
      { path: "eng", count: 1, total: 1 },
      { path: "gtm", count: 1, total: 1 },
    ]);
  });

  it("refuses a folder that would climb out of the nest", async () => {
    // The write path slugifies a traversal away; read paths take the folder
    // verbatim to match what is on disk, so the check has to be explicit and
    // must not rely on the engine happening to catch it downstream.
    for (const bad of ["../..", "gtm/../../etc", "..\\.."]) {
      const listing = await jsonRequest(
        app, "GET",
        `/nests/${nestId}/nodes?folder=${encodeURIComponent(bad)}`,
        undefined, owner.apiKey,
      );
      expect(listing.status, `listing accepted ${bad}`).toBe(400);

      const tree = await folders(`?folder=${encodeURIComponent(bad)}`);
      expect(tree.status, `folder tree accepted ${bad}`).toBe(400);
    }
  });

  it("is withheld from a share grantee, like every whole-nest view", async () => {
    const guest = await registerUser(app, "guest@folders2.test");
    // A grant on ONE document. It buys the document, not the shape of the
    // nest around it — the tree would name folders they were never given.
    const granted = await jsonRequest(
      app, "POST", `/nests/${nestId}/grants`,
      {
        target_type: "document",
        target: "nodes/gtm/deals/deal-one",
        email: guest.email,
        role: "read",
      },
      owner.apiKey,
    );
    expect(granted.status).toBe(201);

    // Same 404 the nest middleware gives a grantee on /overview: existence
    // and no-access are deliberately indistinguishable.
    const { status } = await folders("", guest.apiKey);
    expect(status).toBe(404);

    // The grant itself still works, so this is a scope rule and not a bug.
    const doc = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes/nodes/gtm/deals/deal-one`,
      undefined, guest.apiKey,
    );
    expect(doc.status).toBe(200);
  });
});
