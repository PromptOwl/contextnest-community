/**
 * CU-wdqcq0538j — a public reader must never get drafts from the bundle
 * export, even with ?includeDrafts=1. Collaborators still can.
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
    expect(p.some((x) => x.endsWith("draft-doc.md"))).toBe(false);
  }, 60000);

  it("a signed-in non-collaborator (public reader) gets approved docs only", async () => {
    const res = await app.request(url(), { headers: authed(carol.apiKey) });
    expect(res.status).toBe(200);
    const p = await paths(res);
    expect(p.some((x) => x.endsWith("draft-doc.md"))).toBe(false);
  }, 60000);

  it("the owner still gets drafts", async () => {
    const res = await app.request(url(), { headers: authed(alice.apiKey) });
    const p = await paths(res);
    expect(p.some((x) => x.endsWith("draft-doc.md"))).toBe(true);
  }, 60000);
});
