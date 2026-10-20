/**
 * Folder rename / move: POST /nests/:id/folders/move relocates a folder and
 * everything under it. Ids change; history and links follow.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Folders" }, alice.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env.cleanup());

const create = (title: string, folder: string) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content: `# ${title}`, folder }, alice.apiKey);
const moveFolder = (folder: string, to: string, key = alice.apiKey) =>
  jsonRequest(app, "POST", `/nests/${nestId}/folders/move`, { folder, to }, key);
const get = (id: string) =>
  jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, alice.apiKey);

describe("folder move", () => {
  it("renames a folder and carries nested documents with it", async () => {
    await create("Kickoff", "projects/acme");
    await create("Notes", "projects/acme/meetings");
    await jsonRequest(
      app, "PATCH", `/nests/${nestId}/nodes/nodes/projects/acme/kickoff`,
      { content: "# Kickoff\n\nv2" }, alice.apiKey,
    );

    const res = await moveFolder("projects/acme", "archive/acme");
    expect(res.status).toBe(200);
    expect(res.data.folder).toBe("archive/acme");
    expect(res.data.moved.map((m: any) => m.id).sort()).toEqual([
      "nodes/archive/acme/kickoff",
      "nodes/archive/acme/meetings/notes",
    ]);

    expect((await get("nodes/projects/acme/kickoff")).status).toBe(404);
    const moved = await get("nodes/archive/acme/kickoff");
    expect(moved.status).toBe(200);
    expect(moved.data.node.title).toBe("Kickoff");
    expect((await get("nodes/archive/acme/meetings/notes")).status).toBe(200);
  });

  it("refuses moving a folder into itself and onto an existing folder", async () => {
    await create("Spec", "docs/api");
    await create("Other", "docs/old");
    expect((await moveFolder("docs/api", "docs/api/v2")).status).toBe(400);
    expect((await moveFolder("docs/api", "docs/old")).status).toBe(409);
  });

  it("moves an empty folder", async () => {
    await jsonRequest(app, "POST", `/nests/${nestId}/folders`, { folder: "scratch" }, alice.apiKey);
    const res = await moveFolder("scratch", "tmp/scratch");
    expect(res.status).toBe(200);
    const folders = await jsonRequest(app, "GET", `/nests/${nestId}/folders`, undefined, alice.apiKey);
    const paths = folders.data.folders.map((f: any) => f.path);
    expect(paths).toContain("tmp/scratch");
    expect(paths).not.toContain("scratch");
  });

  it("is owner/admin only", async () => {
    const bob = await registerUser(app, "bob@acme.com", "Bob");
    const res = await moveFolder("docs/old", "docs/older", bob.apiKey);
    expect([403, 404]).toContain(res.status);
  });
});
