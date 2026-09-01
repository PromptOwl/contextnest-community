/**
 * Version reads are node-scoped reads, and must pass the same gate as the
 * document itself.
 *
 * `GET .../versions` hands out every version's change log, and
 * `GET .../versions/:version` reconstructs a full historical body. Without
 * `canReadNode` both answer anyone who cleared the coarse nest-level gate — so
 * a public reader could read every draft of a document the nest never approved,
 * which is exactly what the approved-only rule exists to prevent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed } from "./helpers";

describe("public reader — versions of a never-approved node", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;
  const nodeId = "nodes/draft-only";
  const DRAFT_LEAK = "SECRET_DRAFT_LEAK internal pricing";

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@pub.test", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Public" }, owner.apiKey);
    nestId = nest.data.nest.id;

    // Stewardship on with the owner as sole reviewer: the owner's own edits
    // land as drafts, so this node never gets an approved version.
    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `nest:
  - email: owner@pub.test, role: reviewer, can_approve: true
`,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);

    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Draft Only", content: "# draft\n\nv1 body" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: `# draft\n\n${DRAFT_LEAK}` },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public" },
      owner.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("the owner still reads both version endpoints", async () => {
    const list = await app.request(`/nests/${nestId}/nodes/${nodeId}/versions`, {
      headers: authed(owner.apiKey),
    });
    expect(list.status).toBe(200);
    const body = await app.request(`/nests/${nestId}/nodes/${nodeId}/versions/2`, {
      headers: authed(owner.apiKey),
    });
    expect(body.status).toBe(200);
    expect((await body.json()).content).toContain(DRAFT_LEAK);
  });

  it("denies an anonymous public reader the version list", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/${nodeId}/versions`);
    expect(res.status).toBe(403);
  });

  it("denies an anonymous public reader a reconstructed draft body", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/${nodeId}/versions/2`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(DRAFT_LEAK);
  });

  it("still serves a public reader the versions of an approved node", async () => {
    // An editor authors and submits; the owner approves. Separation of duties
    // blocks approving one's own submission, so the two roles must differ.
    const editor = await registerUser(app, "dev@pub.test", "Dev");
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "dev@pub.test", permission: "write" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Open Doc", content: "# open\n\npublished body" },
      editor.apiKey,
    );
    const submit = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/open-doc/submit-review`,
      {},
      editor.apiKey,
    );
    expect(submit.status).toBe(201);
    const approve = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/open-doc/approve`,
      {},
      owner.apiKey,
    );
    expect(approve.status).toBe(200);

    const list = await app.request(`/nests/${nestId}/nodes/nodes/open-doc/versions`);
    expect(list.status).toBe(200);
    const body = await app.request(`/nests/${nestId}/nodes/nodes/open-doc/versions/1`);
    expect(body.status).toBe(200);
    expect((await body.json()).content).toContain("published body");
  });
});


/**
 * The list endpoint deliberately ships metadata only (bodies live on disk), so
 * anything diffing two versions must fetch each body from
 * `GET .../versions/:version`. Diffing straight off the list's `content` is
 * what made the editor's Compare paint every line as added.
 */
describe("version list carries no bodies", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@bodies.test", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Bodies" }, owner.apiKey);
    nestId = nest.data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Two Versions", content: "# v1\n\nfirst body" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/two-versions`,
      { content: "# v1\n\nsecond body" },
      owner.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("returns empty content in the list and the real body per version", async () => {
    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/two-versions/versions`,
      undefined,
      owner.apiKey,
    );
    expect(list.status).toBe(200);
    expect(list.data.versions.length).toBeGreaterThan(1);
    for (const v of list.data.versions) expect(v.content ?? "").toBe("");

    const first = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/two-versions/versions/1`,
      undefined,
      owner.apiKey,
    );
    expect(first.status).toBe(200);
    expect(first.data.content).toContain("first body");
  });
});
