/**
 * §1.12 view serving — the trust rule (spec §2.5) end to end.
 *
 *   AC-8  ungoverned nest: an author of ANY view/artifact version up to the
 *         served one who can no longer read the data withholds it — whether
 *         they wrote v1 or a later version. The reverse (author can, viewer
 *         can't) yields no rows either (AC-10).
 *   AC-9  a system / empty / unknown author, or one with nest permission
 *         `none`, withholds every entry.
 *   AC-10 a doc-grantee viewer on an ungoverned nest whose grant covers V and
 *         A but not T or the list members: `d` not_found, `m.items` empty, and
 *         the page's own data/list blocks exclude them too.
 *   AC-11 a public reader gets T's APPROVED rows, on the frame and the page,
 *         and may not pin an unapproved ?v=N (404).
 *   AC-14 a headless access key is refused both routes (403 headless_reader).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
  resetAuthRateLimit,
} from "./helpers.js";

type User = { apiKey: string; userId: string; email: string };

const ART_HTML = "<!doctype html><html><head><script>/*app*/</script></head><body></body></html>";
const T_CSV = "id,label\nr1,Alpha\nr2,Beta\nr3,Gamma";

function nestData(body: string): any {
  const m = /<script type="application\/json" id="nest-data">([\s\S]*?)<\/script>/.exec(body);
  return m ? JSON.parse(m[1]) : null;
}

function harness() {
  const h = {
    app: null as any,
    nestId: "",
    page: (viewId: string, q = "") => `/nests/${h.nestId}/nodes/${viewId}/view/hosted${q}`,
    frame: (viewId: string, block: string, q = "") =>
      `/nests/${h.nestId}/nodes/${viewId}/view/blocks/${block}/hosted${q}`,
    get: (path: string, who: User) => h.app.request(path, { headers: authed(who.apiKey) }),
    async create(body: Record<string, unknown>, who: User) {
      const r = await jsonRequest(h.app, "POST", `/nests/${h.nestId}/nodes`, body, who.apiKey);
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.node.id as string;
    },
    async patch(id: string, body: Record<string, unknown>, who: User) {
      const r = await jsonRequest(h.app, "PATCH", `/nests/${h.nestId}/nodes/${id}`, body, who.apiKey);
      expect(r.status, JSON.stringify(r.data)).toBe(200);
      return r.data;
    },
  };
  return h;
}

describe("ungoverned nest (AC-8, AC-9, AC-10)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  const h = harness();
  let owner: User;
  let editor: User;
  let viewer: User;
  let grantee: User;
  let editorCollabId: string;
  let tId: string;
  let aId: string;
  let byEditorV1: string; // the editor wrote v1
  let byEditorV2: string; // owner wrote v1, the editor wrote v2
  let grantView: string; // owner-only view, shared to the grantee with A
  let rowView: string; // owner-only view whose author rows the test rewrites

  const blocks = () => [
    { id: "d", data: { binding: tId } },
    { id: "m", list: { select: "#metric" } },
    { id: "h", html: { ref: aId, data_from: ["d", "m"] } },
  ];

  beforeAll(async () => {
    env = setupTestEnv();
    h.app = await createTestApp("key");
    owner = await registerUser(h.app, "owner@trust.test", "Owner");
    editor = await registerUser(h.app, "editor@trust.test", "Editor");
    viewer = await registerUser(h.app, "viewer@trust.test", "Viewer");
    await resetAuthRateLimit();
    grantee = await registerUser(h.app, "grantee@trust.test", "Grantee");
    const nest = await jsonRequest(h.app, "POST", "/nests", { name: "Trust" }, owner.apiKey);
    h.nestId = nest.data.nest.id;
    const ed = await jsonRequest(
      h.app,
      "POST",
      `/nests/${h.nestId}/collaborators`,
      { email: editor.email, permission: "write" },
      owner.apiKey,
    );
    expect(ed.status).toBe(201);
    editorCollabId = ed.data.collaborator.id;
    const vw = await jsonRequest(
      h.app,
      "POST",
      `/nests/${h.nestId}/collaborators`,
      { email: viewer.email, permission: "read" },
      owner.apiKey,
    );
    expect(vw.status).toBe(201);

    await h.create({ title: "Metric One", content: "one", tags: ["metric"] }, owner);
    tId = await h.create({ title: "Ledger", type: "table", content: T_CSV }, owner);
    aId = await h.create({ title: "Dash", type: "artifact", content: ART_HTML }, owner);
    byEditorV1 = await h.create(
      { title: "Editor View", type: "view", content: "by the editor", view: { blocks: blocks() } },
      editor,
    );
    byEditorV2 = await h.create(
      { title: "Shared View", type: "view", content: "by the owner", view: { blocks: blocks() } },
      owner,
    );
    await h.patch(byEditorV2, { content: "edited by the editor" }, editor);
    grantView = await h.create(
      { title: "Grant View", type: "view", content: "for the grantee", view: { blocks: blocks() } },
      owner,
    );
    rowView = await h.create(
      { title: "Row View", type: "view", content: "author rows", view: { blocks: blocks() } },
      owner,
    );
    for (const target of [grantView, aId]) {
      const g = await jsonRequest(
        h.app,
        "POST",
        `/nests/${h.nestId}/grants`,
        { target_type: "document", target, email: grantee.email, role: "read" },
        owner.apiKey,
      );
      expect(g.status, JSON.stringify(g.data)).toBeLessThan(300);
    }
  }, 60000);

  afterAll(() => env.cleanup());

  it("while every author is a member, the viewer gets the rows", async () => {
    for (const v of [byEditorV1, byEditorV2]) {
      const res = await h.get(h.frame(v, "h"), viewer);
      expect(res.status).toBe(200);
      const data = nestData(await res.text());
      expect(data.d.ok, v).toBe(true);
      expect(data.d.rows.map((r: any) => r.id)).toEqual(["r1", "r2", "r3"]);
    }
  });

  it("AC-10: a doc-grantee viewer gets no rows and no list members — frame and page alike", async () => {
    const res = await h.get(h.frame(grantView, "h"), grantee);
    expect(res.status).toBe(200);
    const data = nestData(await res.text());
    expect(data.d).toEqual({ ok: false, kind: "data", error: "not_found" });
    expect(data.m.ok).toBe(true);
    expect(data.m.items).toEqual([]);
    const pageRes = await h.get(h.page(grantView), grantee);
    expect(pageRes.status).toBe(200);
    const body = await pageRes.text();
    expect(body).toContain("for the grantee");
    expect(body).not.toContain("Alpha");
    expect(body).not.toContain("Metric One");
  });

  it("AC-10: the grantee cannot open a view their grant does not cover", async () => {
    const res = await h.get(h.page(byEditorV1), grantee);
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("Alpha");
  });

  it("AC-9: a system, empty or unknown author on either chain withholds every entry", async () => {
    const { getDb } = await import("../src/db/client.js");
    const db = getDb();
    const original = (await db.get(
      "SELECT author FROM node_versions WHERE nest_id = ? AND node_id = ? AND version = 1",
      [h.nestId, rowView],
    )) as { author: string };
    try {
      for (const bad of ["system:auto-publish:owner@trust.test", "", "ghost@nowhere.test"]) {
        await db.run(
          "UPDATE node_versions SET author = ? WHERE nest_id = ? AND node_id = ? AND version = 1",
          [bad, h.nestId, rowView],
        );
        const res = await h.get(h.frame(rowView, "h"), viewer);
        expect(res.status, bad).toBe(200);
        expect(nestData(await res.text()), JSON.stringify(bad)).toEqual({
          d: { ok: false, kind: "data", error: "withheld" },
          m: { ok: false, kind: "list", error: "withheld" },
        });
      }
    } finally {
      await db.run(
        "UPDATE node_versions SET author = ? WHERE nest_id = ? AND node_id = ? AND version = 1",
        [original.author, h.nestId, rowView],
      );
    }
    // And the artifact's chain counts the same way.
    const art = (await db.get(
      "SELECT author FROM node_versions WHERE nest_id = ? AND node_id = ? AND version = 1",
      [h.nestId, aId],
    )) as { author: string };
    try {
      await db.run(
        "UPDATE node_versions SET author = ? WHERE nest_id = ? AND node_id = ? AND version = 1",
        ["ghost@nowhere.test", h.nestId, aId],
      );
      const data = nestData(await (await h.get(h.frame(rowView, "h"), viewer)).text());
      expect(data.d.error).toBe("withheld");
    } finally {
      await db.run(
        "UPDATE node_versions SET author = ? WHERE nest_id = ? AND node_id = ? AND version = 1",
        [art.author, h.nestId, aId],
      );
    }
    const restored = nestData(await (await h.get(h.frame(rowView, "h"), viewer)).text());
    expect(restored.d.ok).toBe(true);
  });

  // Runs last: it removes the editor from the nest.
  it("AC-8 / AC-9: once an author loses nest access, every entry is withheld — v1 or a later version", async () => {
    const del = await jsonRequest(
      h.app,
      "DELETE",
      `/nests/${h.nestId}/collaborators/${editorCollabId}`,
      undefined,
      owner.apiKey,
    );
    expect(del.status).toBeLessThan(300);
    for (const v of [byEditorV1, byEditorV2]) {
      const res = await h.get(h.frame(v, "h"), viewer);
      expect(res.status).toBe(200);
      const data = nestData(await res.text());
      expect(data, v).toEqual({
        d: { ok: false, kind: "data", error: "withheld" },
        m: { ok: false, kind: "list", error: "withheld" },
      });
    }
    // Pinning the owner-only v1 of the shared view drops the editor's v2 from
    // the chain: the data comes back.
    const v1 = nestData(await (await h.get(h.frame(byEditorV2, "h", "?v=1"), viewer)).text());
    expect(v1.d.ok).toBe(true);
  });
});

describe("public reader of a governed nest (AC-11)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  const h = harness();
  let owner: User;
  let outsider: User;
  let tId: string;
  let vId: string;
  let draftV: number;

  beforeAll(async () => {
    env = setupTestEnv();
    h.app = await createTestApp("key");
    owner = await registerUser(h.app, "owner@pubview.test", "Owner");
    outsider = await registerUser(h.app, "outsider@pubview.test", "Outsider");
    const nest = await jsonRequest(h.app, "POST", "/nests", { name: "Public Views" }, owner.apiKey);
    h.nestId = nest.data.nest.id;
    await jsonRequest(
      h.app,
      "PATCH",
      `/nests/${h.nestId}/settings`,
      { stewardship_enabled: true, allow_self_approve: true },
      owner.apiKey,
    );
    await jsonRequest(
      h.app,
      "PATCH",
      `/nests/${h.nestId}/visibility`,
      { visibility: "public", acknowledge_public: true },
      owner.apiKey,
    );
    tId = await h.create({ title: "Ledger", type: "table", content: T_CSV }, owner);
    const aId = await h.create({ title: "Dash", type: "artifact", content: ART_HTML }, owner);
    vId = await h.create(
      {
        title: "Public View",
        type: "view",
        content: "public intro",
        view: { blocks: [{ id: "d", data: { binding: tId } }, { id: "h", html: { ref: aId, data_from: ["d"] } }] },
      },
      owner,
    );
    await jsonRequest(h.app, "PATCH", `/nests/${h.nestId}/settings`, { allow_self_approve: false }, owner.apiKey);
    await h.patch(tId, { content: "id,label\nr1,Alpha\nr2,UNAPPROVED\nr3,Gamma" }, owner);
    draftV = (await h.patch(vId, { content: "public intro, edited" }, owner)).version;
  }, 60000);

  afterAll(() => env.cleanup());

  it("the frame carries T's approved rows, not the pending edit", async () => {
    const res = await h.get(h.frame(vId, "h"), outsider);
    expect(res.status).toBe(200);
    const data = nestData(await res.text());
    expect(data.d.ok).toBe(true);
    expect(data.d.rows.find((r: any) => r.id === "r2").label).toBe("Beta");
  });

  it("the page does too", async () => {
    const res = await h.get(h.page(vId), outsider);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<td>Beta</td>");
    expect(body).not.toContain("UNAPPROVED");
    expect(body).not.toContain("public intro, edited");
  });

  it("pinning an unapproved ?v=N is 404", async () => {
    expect(draftV).toBeGreaterThan(1);
    expect((await h.get(h.page(vId, `?v=${draftV}`), outsider)).status).toBe(404);
    expect((await h.get(h.frame(vId, "h", `?v=${draftV}`), outsider)).status).toBe(404);
    expect((await h.get(h.page(vId, "?v=1"), outsider)).status).toBe(200);
  });
});

describe("headless access key (AC-14)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  const h = harness();
  let owner: User;
  let readerKey: string;
  let vId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    h.app = await createTestApp("key", { ownerEmail: "owner@headless-view.test" });
    owner = await registerUser(h.app, "owner@headless-view.test", "Owner");
    const nest = await jsonRequest(h.app, "POST", "/nests", { name: "Headless Views" }, owner.apiKey);
    h.nestId = nest.data.nest.id;
    const tId = await h.create({ title: "Ledger", type: "table", content: T_CSV }, owner);
    const aId = await h.create({ title: "Dash", type: "artifact", content: ART_HTML }, owner);
    vId = await h.create(
      {
        title: "Headless View",
        type: "view",
        content: "intro",
        view: { blocks: [{ id: "d", data: { binding: tId } }, { id: "h", html: { ref: aId, data_from: ["d"] } }] },
      },
      owner,
    );
    const on = await jsonRequest(h.app, "PUT", `/nests/${h.nestId}/headless`, { enabled: true }, owner.apiKey);
    expect(on.status).toBe(200);
    const key = await jsonRequest(h.app, "POST", `/nests/${h.nestId}/headless/keys`, { label: "R" }, owner.apiKey);
    expect(key.status).toBe(201);
    readerKey = key.data.api_key;
  }, 60000);

  afterAll(() => env.cleanup());

  it("is refused the page and the frame with 403 headless_reader", async () => {
    for (const p of [h.page(vId), h.frame(vId, "h"), h.page(vId, "?v=1")]) {
      const res = await h.app.request(p, { headers: authed(readerKey) });
      expect(res.status, p).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text).code).toBe("headless_reader");
      expect(text).not.toContain("Alpha");
    }
  });
});
