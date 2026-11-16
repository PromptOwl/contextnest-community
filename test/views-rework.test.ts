/**
 * §1.12 view serving — fixes from the round-1 security review.
 *
 *   H-1  A governed nest's "approved" can be a self-publication, so the frame's
 *        data is ALWAYS bounded by the version authors too, not by the viewer
 *        alone: an author without access withholds on a governed nest.
 *   M-1  The frame refuses a top-level load (Sec-Fetch-Dest other than
 *        iframe → 403; absent header allowed) and pins frame-ancestors 'self'
 *        whatever FRAME_ANCESTORS says.
 *   M-2  A service (access-key / persona) or named-system author withholds.
 *   M-3  A sealed version with no version row (an author we cannot name)
 *        withholds.
 *   M-4  List blocks show approved-only readers the APPROVED title, never a
 *        live copy that merely claims `status: published`.
 *   L-2  A view the viewer cannot read is 404, like a missing one.
 *   L-7  /p shows the approved version's title.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "fs";
import { join } from "path";
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
const T_CSV = "id,label\nr1,Alpha\nr2,Beta";
const WITHHELD = {
  d: { ok: false, kind: "data", error: "withheld" },
  m: { ok: false, kind: "list", error: "withheld" },
};

function nestData(body: string): any {
  const m = /<script type="application\/json" id="nest-data">([\s\S]*?)<\/script>/.exec(body);
  return m ? JSON.parse(m[1]) : null;
}

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let member: User;
let outsider: User;
let nobody: User;
let nestId: string;
let tId: string;
let aId: string;
let vId: string;
let draftOnlyView: string;
let slug: string;
const prevFrameAncestors = process.env.FRAME_ANCESTORS;

const page = (v: string, q = "") => `/nests/${nestId}/nodes/${v}/view/hosted${q}`;
const frame = (v: string, b: string, q = "") => `/nests/${nestId}/nodes/${v}/view/blocks/${b}/hosted${q}`;
const get = (path: string, who: User, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { ...authed(who.apiKey), ...headers } });
async function create(body: Record<string, unknown>) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, owner.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.node.id as string;
}
async function db() {
  return (await import("../src/db/client.js")).getDb();
}

beforeAll(async () => {
  // A broader embedding allowance must not reach the data-carrying frame.
  process.env.FRAME_ANCESTORS = "https://dataroom.example";
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@rework.test", "Owner");
  member = await registerUser(app, "member@rework.test", "Member");
  outsider = await registerUser(app, "outsider@rework.test", "Outsider");
  await resetAuthRateLimit();
  nobody = await registerUser(app, "nobody@rework.test", "Nobody");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Rework" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true, allow_self_approve: true },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/visibility`,
    { visibility: "public", acknowledge_public: true },
    owner.apiKey,
  );
  const c = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: member.email, permission: "read" },
    owner.apiKey,
  );
  expect(c.status).toBe(201);
  await create({ title: "Metric One", content: "one", tags: ["metric"] });
  tId = await create({ title: "Ledger", type: "table", content: T_CSV });
  aId = await create({ title: "Dash", type: "artifact", content: ART_HTML });
  vId = await create({
    title: "Approved View Title",
    type: "view",
    content: "intro",
    view: {
      blocks: [
        { id: "d", data: { binding: tId } },
        { id: "m", list: { select: "#metric" } },
        { id: "h", html: { ref: aId, data_from: ["d", "m"] } },
      ],
    },
  });
  const pub = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/publications`,
    { node_id: vId, access_mode: "public" },
    owner.apiKey,
  );
  expect(pub.status).toBe(201);
  slug = pub.data.publish.slug;

  await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { allow_self_approve: false }, owner.apiKey);
  draftOnlyView = await create({
    title: "Draft Only View",
    type: "view",
    content: "draft",
    view: { blocks: [{ callout: { text: "x" } }] },
  });
  const renamed = await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/nodes/${vId}`,
    { title: "Unapproved New Title" },
    owner.apiKey,
  );
  expect(renamed.status).toBe(200);
}, 60000);

afterAll(async () => {
  if (prevFrameAncestors === undefined) delete process.env.FRAME_ANCESTORS;
  else process.env.FRAME_ANCESTORS = prevFrameAncestors;
  await env.cleanup();
});

/** Rewrite one version row's author for the duration of `fn`. */
async function withAuthor(nest: string, nodeId: string, author: string, fn: () => Promise<void>) {
  const d = await db();
  const row = (await d.get(
    "SELECT author FROM node_versions WHERE nest_id = ? AND node_id = ? AND version = 1",
    [nest, nodeId],
  )) as { author: string };
  await d.run("UPDATE node_versions SET author = ? WHERE nest_id = ? AND node_id = ? AND version = 1", [
    author,
    nest,
    nodeId,
  ]);
  try {
    await fn();
  } finally {
    await d.run("UPDATE node_versions SET author = ? WHERE nest_id = ? AND node_id = ? AND version = 1", [
      row.author,
      nest,
      nodeId,
    ]);
  }
}

describe("baseline", () => {
  it("a member gets the data", async () => {
    const res = await get(frame(vId, "h"), member);
    expect(res.status).toBe(200);
    expect(nestData(await res.text()).d.ok).toBe(true);
  });
});

describe("H-1: governed nests intersect with the version authors too", () => {
  // A PRIVATE governed nest: the rewritten author has no standing in it at all
  // (in the public nest above, anyone is an approved-only reader).
  let priv: string;
  let pv: string;
  let pa: string;
  const pframe = () => `/nests/${priv}/nodes/${pv}/view/blocks/h/hosted`;
  beforeAll(async () => {
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Private Governed" }, owner.apiKey);
    priv = nest.data.nest.id;
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${priv}/settings`,
      { stewardship_enabled: true, allow_self_approve: true },
      owner.apiKey,
    );
    const mk = async (body: Record<string, unknown>) => {
      const r = await jsonRequest(app, "POST", `/nests/${priv}/nodes`, body, owner.apiKey);
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.node.id as string;
    };
    await mk({ title: "Metric One", content: "one", tags: ["metric"] });
    const t = await mk({ title: "Ledger", type: "table", content: T_CSV });
    pa = await mk({ title: "Dash", type: "artifact", content: ART_HTML });
    pv = await mk({
      title: "Private View",
      type: "view",
      content: "intro",
      view: {
        blocks: [
          { id: "d", data: { binding: t } },
          { id: "m", list: { select: "#metric" } },
          { id: "h", html: { ref: pa, data_from: ["d", "m"] } },
        ],
      },
    });
  });

  it("baseline: the owner gets the data", async () => {
    expect(nestData(await (await get(pframe(), owner)).text()).d.ok).toBe(true);
  });

  it("a view authored by someone with no nest access withholds, even though it is approved", async () => {
    await withAuthor(priv, pv, nobody.email, async () => {
      const res = await get(pframe(), owner);
      expect(res.status).toBe(200);
      expect(nestData(await res.text())).toEqual(WITHHELD);
    });
  });

  it("so does such an author on the artifact's chain", async () => {
    await withAuthor(priv, pa, nobody.email, async () => {
      expect(nestData(await (await get(pframe(), owner)).text())).toEqual(WITHHELD);
    });
  });
});

describe("M-1: the frame is a frame", () => {
  it("refuses a top-level load and accepts an iframe load", async () => {
    const top = await get(frame(vId, "h"), member, { "Sec-Fetch-Dest": "document" });
    expect(top.status).toBe(403);
    expect(await top.text()).not.toContain("nest-data");
    const inFrame = await get(frame(vId, "h"), member, { "Sec-Fetch-Dest": "iframe" });
    expect(inFrame.status).toBe(200);
    expect(nestData(await inFrame.text()).d.ok).toBe(true);
  });

  it("pins frame-ancestors 'self' on the frame, whatever FRAME_ANCESTORS allows", async () => {
    const csp = (await get(frame(vId, "h"), member)).headers.get("content-security-policy")!;
    expect(csp).toMatch(/frame-ancestors 'self'$/);
    expect(csp).not.toContain("dataroom.example");
    // The page keeps the server-wide policy.
    const pageCsp = (await get(page(vId), member)).headers.get("content-security-policy")!;
    expect(pageCsp).toContain("https://dataroom.example");
  });
});

describe("M-2: service and system authors withhold", () => {
  it("an author whose account is a service identity", async () => {
    const d = await db();
    await d.run("UPDATE users SET is_service = 1 WHERE id = ?", [owner.userId]);
    try {
      expect(nestData(await (await get(frame(vId, "h"), member)).text())).toEqual(WITHHELD);
    } finally {
      await d.run("UPDATE users SET is_service = 0 WHERE id = ?", [owner.userId]);
    }
  });

  it("an author that is a named system account", async () => {
    const d = await db();
    await d.run(
      "INSERT INTO system_accounts (user_id, name, capability) VALUES (?, ?, 'write')",
      [owner.userId, "Pipeline"],
    );
    try {
      expect(nestData(await (await get(frame(vId, "h"), member)).text())).toEqual(WITHHELD);
    } finally {
      await d.run("DELETE FROM system_accounts WHERE user_id = ?", [owner.userId]);
    }
    expect(nestData(await (await get(frame(vId, "h"), member)).text()).d.ok).toBe(true);
  });
});

describe("M-3: a sealed version with no row fails closed", () => {
  it("withholds when the artifact's v1 row is gone", async () => {
    const d = await db();
    const row = (await d.get(
      "SELECT * FROM node_versions WHERE nest_id = ? AND node_id = ? AND version = 1",
      [nestId, aId],
    )) as Record<string, unknown>;
    await d.run("DELETE FROM node_versions WHERE nest_id = ? AND node_id = ? AND version = 1", [nestId, aId]);
    try {
      expect(nestData(await (await get(frame(vId, "h"), member)).text())).toEqual(WITHHELD);
    } finally {
      const cols = Object.keys(row).filter((k) => k !== "id");
      await d.run(
        `INSERT INTO node_versions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        cols.map((k) => row[k]),
      );
    }
    expect(nestData(await (await get(frame(vId, "h"), member)).text()).d.ok).toBe(true);
  });
});

describe("L-2 / L-7", () => {
  it("a view a public reader cannot read is 404 on both routes, like a missing one", async () => {
    expect((await get(page(draftOnlyView), outsider)).status).toBe(404);
    expect((await get(frame(draftOnlyView, "_b0"), outsider)).status).toBe(404);
    expect((await get(page("nodes/no-such-view"), outsider)).status).toBe(404);
  });

  it("/p shows the approved version's title, not an unapproved rename", async () => {
    const body = await (await app.request(`/p/${slug}`)).text();
    expect(body).toContain("Approved View Title");
    expect(body).not.toContain("Unapproved New Title");
  });
});

// Runs last: it edits a file behind the server's back.
describe("M-4: approved-only readers get approved list values", () => {
  it("a live copy claiming status: published cannot put an unreviewed title in front of them", async () => {
    writeFileSync(
      join(env.dataDir, "nests", nestId, "nodes", "metric-one.md"),
      "---\ntitle: LEAKED TITLE\nid: nodes/metric-one\ntype: document\nstatus: published\ntags:\n  - metric\n---\nunreviewed\n",
    );
    const { engineCache } = await import("../src/nodes/engine.js");
    engineCache.evict(nestId);
    const res = await get(frame(vId, "h"), outsider);
    expect(res.status).toBe(200);
    const data = nestData(await res.text());
    expect(data.m.ok).toBe(true);
    expect(data.m.items.map((i: any) => i.title)).toEqual(["Metric One"]);
    const body = await (await get(page(vId), outsider)).text();
    expect(body).toContain("Metric One");
    expect(body).not.toContain("LEAKED TITLE");
  });
});
