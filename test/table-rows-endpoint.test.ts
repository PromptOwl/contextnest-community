/**
 * POST /nests/:nestId/nodes/:nodeId/rows — row ops on a table node, written
 * through the same update/governance path as a body edit.
 *
 * AC (Engineering Ops task community-nest-views-write-rows-back-to-tables-as-governed-drafts):
 *  - governed nest, editor → a draft with only the changed row, in the review queue
 *  - ungoverned nest → publishes directly
 *  - reader → refused, nothing written
 *  - stale base_version → 409 with the current version, nothing written
 *  - duplicate key / non-number in :number → 400, nothing written
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

type User = { apiKey: string; userId: string; email: string };

const T_CSV = "id:key,stage,amount:number\nr1,lead,10\nr2,won,20";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let editor: User;
let reader: User;
let openNest: string;
let govNest: string;

async function mk(nestId: string, body: Record<string, unknown>, who: User = owner) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, who.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.node.id as string;
}

const rows = (nestId: string, id: string, body: unknown, who: User) =>
  jsonRequest(app, "POST", `/nests/${nestId}/nodes/${id}/rows`, body, who.apiKey);

async function content(nestId: string, id: string) {
  const r = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`, undefined, owner.apiKey);
  return { content: (r.data.node.content as string).trimEnd(), version: r.data.node.version as number, status: r.data.node.status };
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@rows.test", "Owner");
  editor = await registerUser(app, "editor@rows.test", "Editor");
  reader = await registerUser(app, "reader@rows.test", "Reader");
  await resetAuthRateLimit();
  openNest = (await jsonRequest(app, "POST", "/nests", { name: "Open Rows" }, owner.apiKey)).data.nest.id;
  govNest = (await jsonRequest(app, "POST", "/nests", { name: "Gov Rows" }, owner.apiKey)).data.nest.id;
  await jsonRequest(app, "PATCH", `/nests/${govNest}/settings`, { stewardship_enabled: true, allow_self_approve: true }, owner.apiKey);
  for (const n of [openNest, govNest]) {
    await jsonRequest(app, "POST", `/nests/${n}/collaborators`, { email: editor.email, permission: "write" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${n}/collaborators`, { email: reader.email, permission: "read" }, owner.apiKey);
  }
});

afterAll(() => env.cleanup());

describe("ungoverned nest", () => {
  it("publishes the change directly and reports the new version", async () => {
    const t = await mk(openNest, { title: "Open Pipeline", type: "table", content: T_CSV });
    const before = await content(openNest, t);
    const r = await rows(openNest, t, { ops: [{ op: "update", key: "r1", set: { stage: "qualified" } }] }, editor);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.state).toBe("published");
    expect(r.data.applied).toEqual({ appended: 0, updated: 1, deleted: 0 });
    expect(r.data.version).toBeGreaterThan(before.version);
    const after = await content(openNest, t);
    expect(after.content).toBe("id:key,stage,amount:number\nr1,qualified,10\nr2,won,20");
    expect(after.status).toBe("published");
  });

  it("an unchanged write is a no-op, not a new version", async () => {
    const t = await mk(openNest, { title: "Noop Pipeline", type: "table", content: T_CSV });
    const before = await content(openNest, t);
    const r = await rows(openNest, t, { ops: [{ op: "update", key: "r1", set: { stage: "lead" } }] }, editor);
    expect(r.status).toBe(200);
    expect(r.data.unchanged).toBe(true);
    expect((await content(openNest, t)).version).toBe(before.version);
  });
});

describe("governed nest", () => {
  it("an editor's update lands as a draft with only that row changed, submitted for review", async () => {
    const t = await mk(govNest, { title: "Gov Pipeline", type: "table", content: T_CSV });
    const r = await rows(govNest, t, { ops: [{ op: "update", key: "r1", set: { stage: "qualified" } }], submit_review: true }, editor);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.state).toBe("draft");
    expect(typeof r.data.review_id).toBe("string");

    // The working copy has exactly r1 changed; the approved version is untouched.
    const live = await content(govNest, t);
    expect(live.content).toBe("id:key,stage,amount:number\nr1,qualified,10\nr2,won,20");
    const approved = await jsonRequest(app, "GET", `/nests/${govNest}/nodes/${t}?approved_only=1`, undefined, owner.apiKey);
    expect(approved.data.node.content.trimEnd()).toBe(T_CSV);

    const queue = await jsonRequest(app, "GET", `/nests/${govNest}/review-queue`, undefined, owner.apiKey);
    expect(queue.status).toBe(200);
    expect(queue.data.requests.some((q: any) => q.nodeId === t)).toBe(true);
  });

  it("without submit_review the draft is saved but not queued", async () => {
    const t = await mk(govNest, { title: "Gov Quiet", type: "table", content: T_CSV });
    const r = await rows(govNest, t, { ops: [{ op: "delete", key: "r2" }] }, editor);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.state).toBe("draft");
    expect(r.data.review_id).toBeUndefined();
  });
});

describe("refusals write nothing", () => {
  let t: string;
  let baseline: { content: string; version: number };
  beforeAll(async () => {
    t = await mk(openNest, { title: "Guarded Pipeline", type: "table", content: T_CSV });
    baseline = await content(openNest, t);
  });
  const unchanged = async () => {
    const now = await content(openNest, t);
    expect(now.content).toBe(baseline.content);
    expect(now.version).toBe(baseline.version);
  };

  it("a reader is refused", async () => {
    const r = await rows(openNest, t, { ops: [{ op: "delete", key: "r1" }] }, reader);
    expect(r.status).toBe(403);
    await unchanged();
  });

  it("a stale base_version → 409 with the current version", async () => {
    const r = await rows(openNest, t, { ops: [{ op: "delete", key: "r1" }], base_version: baseline.version - 1 }, editor);
    expect(r.status).toBe(409);
    expect(r.data.current_version).toBe(baseline.version);
    await unchanged();
  });

  it("a matching base_version is accepted", async () => {
    const t2 = await mk(openNest, { title: "Based Pipeline", type: "table", content: T_CSV });
    const { version } = await content(openNest, t2);
    const r = await rows(openNest, t2, { ops: [{ op: "delete", key: "r1" }], base_version: version }, editor);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
  });

  it("an append with a duplicate key → 400", async () => {
    const r = await rows(openNest, t, { ops: [{ op: "append", row: { id: "r1", stage: "x" } }] }, editor);
    expect(r.status).toBe(400);
    await unchanged();
  });

  it("a non-number in a :number column → 400", async () => {
    const r = await rows(openNest, t, { ops: [{ op: "append", row: { id: "r9", amount: "lots" } }] }, editor);
    expect(r.status).toBe(400);
    await unchanged();
  });

  it("a good op followed by a bad one → 400 and neither applies", async () => {
    const r = await rows(
      openNest,
      t,
      { ops: [{ op: "update", key: "r1", set: { stage: "won" } }, { op: "update", key: "missing", set: { stage: "x" } }] },
      editor,
    );
    expect(r.status).toBe(400);
    await unchanged();
  });

  it("a non-table node → 400", async () => {
    const d = await mk(openNest, { title: "Plain Doc", content: "hello" });
    const r = await rows(openNest, d, { ops: [{ op: "delete", key: "r1" }] }, editor);
    expect(r.status).toBe(400);
  });

  it("a missing node → 404", async () => {
    const r = await rows(openNest, "nodes/nope", { ops: [{ op: "delete", key: "r1" }] }, editor);
    expect(r.status).toBe(404);
  });

  it("a non-member → 404 (the nest is invisible to them)", async () => {
    const stranger = await registerUser(app, "stranger@rows.test", "Stranger");
    const r = await rows(openNest, t, { ops: [{ op: "delete", key: "r1" }] }, stranger);
    expect([403, 404]).toContain(r.status);
    await unchanged();
  });
});
