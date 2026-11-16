/**
 * Re-uploading an Office file onto the document it created: a new version of
 * that document (REST nodeId / MCP node_id), never a second document.
 *
 *  - Given a pptx-sourced doc, when a new pptx is uploaded with its nodeId,
 *    then version N+1 has the new text and the original link the new file;
 *    the earlier file still downloads for someone who can read history.
 *  - Given a governed nest, then it lands as a draft, and a public reader
 *    still gets only the approved version's file.
 *  - Given hand edits since the last upload, then the response warns.
 *  - Given the wrong kind of file, or a caller who can't edit, then refused.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed, resetAuthRateLimit } from "./helpers.js";
import { buildDocx, buildPptx } from "./office-fixtures.js";

type User = { apiKey: string; userId: string; email: string };

function uploadOffice(app: any, nestId: string, apiKey: string, bytes: Uint8Array, filename: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new File([bytes], filename));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return app.request(`/nests/${nestId}/nodes/office`, { method: "POST", headers: authed(apiKey), body: form });
}

const download = (app: any, nestId: string, file: string, apiKey: string) =>
  app.request(`/nests/${nestId}/originals/${file}`, { headers: authed(apiKey) });

describe("re-uploading an Office file as a new version", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: User;
  let viewer: User;
  let stranger: User;
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@reup.test", "Owner");
    viewer = await registerUser(app, "viewer@reup.test", "Viewer");
    stranger = await registerUser(app, "stranger@reup.test", "Stranger");
    await resetAuthRateLimit();
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Reupload" }, owner.apiKey)).data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: viewer.email, permission: "read" }, owner.apiKey);
  });

  afterAll(() => env.cleanup());

  it("replaces the text and the original as version 2 of the same document", async () => {
    const v1 = await buildPptx([{ title: "Plan", bullets: ["Ship in March"] }]);
    const first = await (await uploadOffice(app, nestId, owner.apiKey, v1, "Roadmap.pptx")).json();
    const v2 = await buildPptx([{ title: "Plan", bullets: ["Ship in May"] }]);
    const res = await uploadOffice(app, nestId, owner.apiKey, v2, "Roadmap v2.pptx", { nodeId: first.node.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.node.id).toBe(first.node.id);
    expect(body.version).toBe(first.version + 1);
    expect(body.warnings).toBeUndefined();
    expect(body.node.content).toContain("Ship in May");
    expect(body.node.content).not.toContain("Ship in March");
    expect(body.node.content).toContain(`/originals/${body.node.original.file}`);
    expect(body.node.original.file).not.toBe(first.node.original.file);

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, owner.apiKey);
    expect(list.data.nodes.filter((n: any) => n.title === "Roadmap")).toHaveLength(1);
    // Both files download: v2 is current, v1 belongs to version 1.
    expect(new Uint8Array(await (await download(app, nestId, body.node.original.file, owner.apiKey)).arrayBuffer())).toEqual(v2);
    expect(new Uint8Array(await (await download(app, nestId, first.node.original.file, owner.apiKey)).arrayBuffer())).toEqual(v1);
  });

  it("warns when hand edits since the last upload were replaced", async () => {
    const first = await (await uploadOffice(app, nestId, owner.apiKey, await buildDocx([{ p: "Draft one" }]), "Memo.docx")).json();
    await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${first.node.id}`, { content: `${first.node.content}\nA hand-written line.` }, owner.apiKey);
    const res = await uploadOffice(app, nestId, owner.apiKey, await buildDocx([{ p: "Draft two" }]), "Memo.docx", { nodeId: first.node.id });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.warnings).toEqual([expect.stringMatching(/edits made to the document since the last upload were replaced/i)]);
  });

  it("refuses a different kind of file, a document not from an upload, and a caller who can't edit", async () => {
    const deck = await (await uploadOffice(app, nestId, owner.apiKey, await buildPptx([{ title: "A" }]), "Kind.pptx")).json();
    const wrongKind = await uploadOffice(app, nestId, owner.apiKey, await buildDocx([{ p: "x" }]), "Kind.docx", { nodeId: deck.node.id });
    expect(wrongKind.status).toBe(400);
    expect((await wrongKind.json()).error).toMatch(/\.pptx/);

    const plain = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Plain", content: "text" }, owner.apiKey);
    const notOffice = await uploadOffice(app, nestId, owner.apiKey, await buildPptx([{ title: "A" }]), "x.pptx", { nodeId: plain.data.node.id });
    expect(notOffice.status).toBe(400);

    const asViewer = await uploadOffice(app, nestId, viewer.apiKey, await buildPptx([{ title: "B" }]), "Kind.pptx", { nodeId: deck.node.id });
    expect([403, 404]).toContain(asViewer.status);
    const asStranger = await uploadOffice(app, nestId, stranger.apiKey, await buildPptx([{ title: "B" }]), "Kind.pptx", { nodeId: deck.node.id });
    expect([403, 404]).toContain(asStranger.status);
  });

  it("in a governed nest lands as a draft, and a public reader keeps getting only the approved file", async () => {
    const v1 = await buildPptx([{ title: "Public", bullets: ["Approved text"] }]);
    const first = await (await uploadOffice(app, nestId, owner.apiKey, v1, "Public Deck.pptx")).json();
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);

    const v2 = await buildPptx([{ title: "Public", bullets: ["Unreviewed text"] }]);
    const res = await uploadOffice(app, nestId, owner.apiKey, v2, "Public Deck.pptx", { nodeId: first.node.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.node.status).not.toBe("published");

    // The stranger reads the public nest: approved version only.
    expect((await download(app, nestId, first.node.original.file, stranger.apiKey)).status).toBe(200);
    expect((await download(app, nestId, body.node.original.file, stranger.apiKey)).status).toBe(404);
    // The owner can read the draft, so the new file too.
    expect((await download(app, nestId, body.node.original.file, owner.apiKey)).status).toBe(200);
  });
});
