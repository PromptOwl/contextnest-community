/**
 * CU-wdqcq0538j — a public reader must never get drafts from the bundle
 * export, even with ?includeDrafts=1. Collaborators still can. A caller
 * without whole-nest read gets only the documents they can read, and no
 * `.versions/**` history (it holds draft bytes of every document).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import JSZip from "jszip";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
} from "./helpers.js";

async function paths(res: Response): Promise<string[]> {
  const zip = await JSZip.loadAsync(await res.arrayBuffer());
  return Object.values(zip.files).filter((e) => !e.dir).map((e) => e.name);
}

describe("bundle export: drafts stay private on public nests", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string };
  let carol: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@test.com", "Alice");
    carol = await registerUser(app, "carol@test.com", "Carol");
    const created = await jsonRequest(app, "POST", "/nests", { name: "Open Nest" }, alice.apiKey);
    nestId = created.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Alpha Doc", content: "# Alpha\n\nalpha" }, alice.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, alice.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Draft Doc", content: "# Draft\n\nsecret draft" }, alice.apiKey);
    const vis = await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "public", acknowledge_public: true }, alice.apiKey);
    expect(vis.status).toBe(200);
  }, 60000);

  afterAll(() => env.cleanup());

  const url = () => `/nests/${nestId}/export?format=bundle&includeDrafts=1`;

  it("an anonymous caller gets approved docs only", async () => {
    const res = await app.request(url());
    expect(res.status).toBe(200);
    const p = await paths(res);
    expect(p.some((x) => x.endsWith("alpha-doc.md"))).toBe(true);
    expect(p.some((x) => x.includes("draft-doc"))).toBe(false);
    expect(p.some((x) => x.includes(".versions/"))).toBe(false);
  }, 60000);

  it("a signed-in non-collaborator (public reader) gets approved docs only", async () => {
    const res = await app.request(url(), { headers: authed(carol.apiKey) });
    expect(res.status).toBe(200);
    const p = await paths(res);
    expect(p.some((x) => x.includes("draft-doc"))).toBe(false);
    expect(p.some((x) => x.includes(".versions/"))).toBe(false);
  }, 60000);

  it("the owner still gets drafts", async () => {
    const res = await app.request(url(), { headers: authed(alice.apiKey) });
    expect(res.status).toBe(200);
    const p = await paths(res);
    expect(p.some((x) => x.endsWith("draft-doc.md"))).toBe(true);
    expect(p.some((x) => x.includes(".versions/"))).toBe(true);
  }, 60000);
});

describe("bundle export: a share grantee gets only their grant", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let guest: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@test.com", "Owner");
    guest = await registerUser(app, "guest@test.com", "Guest");
    const created = await jsonRequest(app, "POST", "/nests", { name: "Private Nest" }, owner.apiKey);
    nestId = created.data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Shared Doc", content: "# Shared\n\nshared" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Other Draft", content: "# Other\n\nnot shared" }, owner.apiKey);
    const share = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "document", target: "nodes/shared-doc", email: "guest@test.com", role: "read" },
      owner.apiKey,
    );
    expect(share.status, JSON.stringify(share.data)).toBe(201);
  }, 60000);

  afterAll(() => env.cleanup());

  it("gets the granted doc, no other doc and no version history", async () => {
    const res = await app.request(
      `/nests/${nestId}/export?format=bundle&includeDrafts=1`,
      { headers: authed(guest.apiKey) },
    );
    expect(res.status).toBe(200);
    const p = await paths(res);
    expect(p).toContain("nodes/shared-doc.md");
    expect(p.some((x) => x.includes("other-draft"))).toBe(false);
    expect(p.some((x) => x.includes(".versions/"))).toBe(false);
  }, 60000);
});
