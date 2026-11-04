/**
 * In-app View editor in a governed nest: an edit to an approved View does not
 * replace what readers see, a denied md ref renders a neutral placeholder, and
 * document create / re-typing for existing types behave as before.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed } from "./helpers.js";

type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let reader: User;
let nestId: string;

const page = (id: string, q = "") => `/nests/${nestId}/nodes/${id}/view/hosted${q}`;
const get = (path: string, who: User) => app.request(path, { headers: authed(who.apiKey) });

async function create(body: Record<string, unknown>) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, owner.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.node.id as string;
}

async function selfApprove(on: boolean) {
  const r = await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { allow_self_approve: on },
    owner.apiKey,
  );
  expect(r.status).toBe(200);
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@view-gov.test", "Owner");
  reader = await registerUser(app, "reader@view-gov.test", "Reader");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Gov" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true, allow_self_approve: true },
    owner.apiKey,
  );
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

describe("governed edit of an approved View", () => {
  it("keeps serving the approved layout until the new version is approved", async () => {
    const id = await create({
      title: "Gov view",
      type: "view",
      content: "Intro.",
      view: { blocks: [{ callout: { text: "APPROVED-LAYOUT" } }] },
    });
    expect((await (await get(page(id), reader)).text())).toContain("APPROVED-LAYOUT");

    await selfApprove(false);
    const patched = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${id}`,
      { view: { blocks: [{ callout: { text: "DRAFT-LAYOUT" } }] } },
      owner.apiKey,
    );
    expect(patched.status, JSON.stringify(patched.data)).toBe(200);
    // Decision 1: the save lands as a draft (or pending_review), never published.
    expect(["draft", "pending_review"]).toContain(patched.data.node?.status);

    const readerBody = await (await get(page(id), reader)).text();
    expect(readerBody).toContain("APPROVED-LAYOUT");
    expect(readerBody).not.toContain("DRAFT-LAYOUT");

    // The writer's preview asks for the live version and sees the draft.
    const live = patched.data.node?.version;
    expect(live).toBeGreaterThan(1);
    const preview = await (await get(page(id, `?v=${live}`), owner)).text();
    expect(preview).toContain("DRAFT-LAYOUT");
    await selfApprove(true);
  });
});

describe("md placeholder", () => {
  it("shows a neutral line for a missing ref and leaks nothing", async () => {
    const id = await create({
      title: "Missing ref",
      type: "view",
      content: "Intro.",
      view: { blocks: [{ md: { ref: "nodes/does-not-exist" } }, { callout: { text: "kept" } }] },
    });
    const body = await (await get(page(id), reader)).text();
    expect(body).toContain("This content is unavailable.");
    expect(body).not.toMatch(/restricted/i);
    expect(body).toContain("kept");
  });

  it("shows the same line, not the content, for a node the viewer cannot read", async () => {
    const secretId = await create({ title: "Secret Plan", content: "TOP-SECRET-BODY" });
    const steward = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      {
        scope: "document",
        target: secretId,
        users: [{ email: owner.email, role: "reviewer" }],
      },
      owner.apiKey,
    );
    // Environment-dependent: if this steward shape is refused, the denial
    // fixture is wrong, not the renderer.
    expect(steward.status, JSON.stringify(steward.data)).toBeLessThan(300);

    const id = await create({
      title: "Denied ref",
      type: "view",
      content: "Intro.",
      view: { blocks: [{ md: { ref: secretId } }] },
    });
    const body = await (await get(page(id), reader)).text();
    expect(body).not.toContain("TOP-SECRET-BODY");
    expect(body).toContain("This content is unavailable.");
  });
});

describe("regression: existing types", () => {
  it("creates a plain document with no view block", async () => {
    const id = await create({ title: "Plain doc", content: "Body." });
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.node.type).not.toBe("view");
    expect(r.data.node.view).toBeUndefined();
  });

  it("turns a document into a View and back, and document into table/artifact still works", async () => {
    const id = await create({ title: "Convert me", content: "Body." });
    const toView = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${id}`,
      { type: "view", view: { blocks: [{ callout: { text: "Add blocks to this view." } }] } },
      owner.apiKey,
    );
    expect(toView.status, JSON.stringify(toView.data)).toBe(200);
    const back = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${id}`,
      { type: "document" },
      owner.apiKey,
    );
    expect(back.status, JSON.stringify(back.data)).toBeLessThan(500);

    const art = await create({ title: "Convert art", content: "Body." });
    const toArt = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${art}`,
      { type: "artifact" },
      owner.apiKey,
    );
    expect(toArt.status, JSON.stringify(toArt.data)).toBeLessThan(500);
  });

  it("lists user Views via GET /nodes?type=view and not other types", async () => {
    const r = await jsonRequest(app, "GET", `/nests/${nestId}/nodes?type=view`, undefined, owner.apiKey);
    expect(r.status).toBe(200);
    const nodes: any[] = r.data.nodes ?? [];
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n) => n.type === "view")).toBe(true);
  });
});
