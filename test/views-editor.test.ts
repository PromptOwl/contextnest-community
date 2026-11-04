/**
 * In-app View editor, server side: the `view` field on GET is for writers only,
 * a seeded create is accepted, and re-typing away from `view` leaves a usable node.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let reader: { apiKey: string; userId: string; email: string };
let nestId: string;

const SEED = { blocks: [{ callout: { text: "Add blocks to this view." } }] };
const LAYOUT = {
  blocks: [
    { md: { ref: "nodes/intro" } },
    { list: { select: "#metric" } },
    { callout: { text: "Note" } },
  ],
};

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@view-editor.test", "Owner");
  reader = await registerUser(app, "reader@view-editor.test", "Reader");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Editor" }, owner.apiKey);
  nestId = nest.data.nest.id;
  const collab = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: reader.email, permission: "read" },
    owner.apiKey,
  );
  expect(collab.status).toBeLessThan(300);
});

afterAll(() => env.cleanup());

async function createView(title: string, view: unknown = SEED) {
  const r = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title, type: "view", content: "Intro.", view },
    owner.apiKey,
  );
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.node.id as string;
}

describe("view field on GET /nodes/:nodeId", () => {
  it("is returned to a writer", async () => {
    const id = await createView("Writer view", LAYOUT);
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.node.view).toEqual(LAYOUT);
  });

  it("is omitted for a read-only caller", async () => {
    const id = await createView("Reader view", LAYOUT);
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, reader.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.node.type).toBe("view");
    expect(r.data.node.view).toBeUndefined();
    expect(JSON.stringify(r.data)).not.toContain("nodes/intro");
  });
});

describe("seeded create", () => {
  it("accepts the single callout seed block", async () => {
    const id = await createView("Seeded", SEED);
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);
    expect(r.data.node.view).toEqual(SEED);
  });

  it("refuses an empty block list (engine rule 32)", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Empty", type: "view", content: "Intro.", view: { blocks: [] } },
      owner.apiKey,
    );
    expect(r.status).toBe(400);
  });
});

describe("re-typing away from view", () => {
  it("does not 500 and leaves a readable node", async () => {
    const id = await createView("Retype", LAYOUT);
    const r = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${id}`,
      { type: "document" },
      owner.apiKey,
    );
    expect(r.status, JSON.stringify(r.data)).toBeLessThan(500);
    const g = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);
    expect(g.status).toBe(200);
  });
});
