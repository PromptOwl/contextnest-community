/**
 * §1.12 view serving over HTTP — the view page and its html-block frames.
 *
 * Fixture (spec §4): a STEWARDED nest with member M and a table T (rows
 * r1..r3, all approved), an approved artifact A, and view V (approved v1):
 *   md{ref:nodes/intro} · m:list{#metric} · d:data{T} · callout · kpi{from:d}
 *   · h:html{ref:A, data_from:[d,m]}
 *
 * Routes (the path ends in /hosted on purpose: the headless access-key
 * allowlist already refuses every node `…/hosted` sub-resource):
 *   GET /nests/:n/nodes/:viewId/view/hosted[?v=N]                 the page
 *   GET /nests/:n/nodes/:viewId/view/blocks/:blockId/hosted[?v=N] a frame
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, statSync, rmSync, existsSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
  resetAuthRateLimit,
} from "./helpers.js";
import { mergeFrameAncestors } from "../src/shared/artifact-sandbox.js";
import { ARTIFACT_SANDBOX_CSP_NO_POPUPS, ARTIFACT_SANDBOX_CSP } from "../src/shared/artifact-sandbox.js";
import { CAPS } from "../src/views/core.js";

type User = { apiKey: string; userId: string; email: string };

const ART_HTML = "<!doctype html><html><head><script>/*app*/</script></head><body></body></html>";
const EVIL = "</script><script>alert(1)</script>\u2028tail";
const T_CSV = `id,label,amount\nr1,Alpha,10\nr2,${EVIL},20\nr3,Gamma,30`;
const T_ROWS = [
  { id: "r1", label: "Alpha", amount: "10" },
  { id: "r2", label: EVIL, amount: "20" },
  { id: "r3", label: "Gamma", amount: "30" },
];

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let member: User;
let stranger: User;
let nestId: string;

const page = (viewId: string, q = "") => `/nests/${nestId}/nodes/${viewId}/view/hosted${q}`;
const frame = (viewId: string, block: string, q = "") =>
  `/nests/${nestId}/nodes/${viewId}/view/blocks/${block}/hosted${q}`;

async function get(path: string, who: User = member) {
  return app.request(path, { headers: authed(who.apiKey) });
}

async function create(body: Record<string, unknown>, who: User = owner) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, who.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.node.id as string;
}

async function patch(id: string, body: Record<string, unknown>, who: User = owner) {
  const r = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, body, who.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
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

/** The parsed `nest-data` JSON of a frame body (and how many there are). */
function nestData(body: string): { count: number; json: any; raw: string } {
  const re = /<script type="application\/json" id="nest-data">([\s\S]*?)<\/script>/g;
  const all = [...body.matchAll(re)];
  const raw = all[0]?.[1] ?? "";
  return { count: all.length, json: raw ? JSON.parse(raw) : null, raw };
}

let tId: string;
let aId: string;
let vId: string;
let draftViewId: string;
let draftArtViewId: string;
let pinView: string;
let bigView: string;
let pinnedMdView: string;
let agentView: string;
let docId: string;

const fixtureBlocks = () => [
  { md: { ref: "nodes/intro" } },
  { id: "m", list: { select: "#metric" } },
  { id: "d", data: { binding: tId } },
  { callout: { text: "Numbers are preliminary", tone: "warning" } },
  { kpi: { from: "d" } },
  { id: "h", html: { ref: aId, data_from: ["d", "m"] } },
];

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@views.test", "Owner");
  member = await registerUser(app, "member@views.test", "Member");
  stranger = await registerUser(app, "stranger@views.test", "Stranger");
  await resetAuthRateLimit();
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Views" }, owner.apiKey);
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
    { email: member.email, permission: "read" },
    owner.apiKey,
  );
  expect(collab.status).toBeLessThan(300);

  await create({ title: "Intro", content: "Welcome to the board intro." });
  await create({ title: "Metric One", content: "one", tags: ["metric"] });
  await create({ title: "Metric Two", content: "two", tags: ["metric"] });
  tId = await create({ title: "Revenue", type: "table", content: T_CSV });
  aId = await create({ title: "Dash", type: "artifact", content: ART_HTML });
  vId = await create({
    title: "Board View",
    type: "view",
    content: "The board, at a glance.",
    view: { blocks: fixtureBlocks() },
  });

  // AC-12: a view whose v1 reads [d] and v2 reads [m], both approved.
  pinView = await create({
    title: "Pin View",
    type: "view",
    content: "pinned",
    view: {
      blocks: [
        { id: "d", data: { binding: tId } },
        { id: "m", list: { select: "#metric" } },
        { id: "h", html: { ref: aId, data_from: ["d"] } },
      ],
    },
  });
  await patch(pinView, {
    view: {
      blocks: [
        { id: "d", data: { binding: tId } },
        { id: "m", list: { select: "#metric" } },
        { id: "h", html: { ref: aId, data_from: ["m"] } },
      ],
    },
  });

  // AC-5: 600 rows, and rows big enough to blow the byte caps.
  const rows600 = ["n,v", ...Array.from({ length: 600 }, (_, i) => `${i},v${i}`)].join("\n");
  const t600 = await create({ title: "Six Hundred", type: "table", content: rows600 });
  const fat = "z".repeat(700);
  const rowsFat = ["n,v", ...Array.from({ length: 450 }, (_, i) => `${i},${fat}`)].join("\n");
  const tFat = await create({ title: "Fat Rows", type: "table", content: rowsFat });
  bigView = await create({
    title: "Big View",
    type: "view",
    content: "big",
    view: {
      blocks: [
        { id: "six", data: { binding: t600 } },
        { id: "f1", data: { binding: tFat } },
        { id: "f2", data: { binding: tFat } },
        { id: "f3", data: { binding: tFat } },
        { id: "f4", data: { binding: tFat } },
        { id: "f5", data: { binding: tFat } },
        { id: "h", html: { ref: aId, data_from: ["six"] } },
        { id: "hf", html: { ref: aId, data_from: ["f1", "f2", "f3", "f4", "f5"] } },
      ],
    },
  });

  // AC-15: a doc whose v2 was a draft when it was cut, and a retracted doc.
  docId = await create({ title: "Pinned Doc", content: "pinned v1" });
  await create({ title: "Retracted Doc", content: "soon retracted" });
  await create({ title: "Fragile Doc", content: "history goes missing" });
  agentView = await create({
    title: "Agent View",
    type: "view",
    content: "agents only",
    view: { audience: ["agent"], blocks: [{ callout: { text: "hi" } }] },
  });

  await selfApprove(false);
  await patch(docId, { content: "pinned v2 draft" }); // v2: a draft
  // AC-7: a draft-only view, and an approved view over a draft-only artifact.
  draftViewId = await create({
    title: "Draft View",
    type: "view",
    content: "draft view",
    view: { blocks: fixtureBlocks() },
  });
  const draftArt = await create({ title: "Draft Dash", type: "artifact", content: ART_HTML });
  await selfApprove(true);
  await patch(docId, { content: "pinned v3 published" }); // v3: published
  draftArtViewId = await create({
    title: "Draft Art View",
    type: "view",
    content: "over a draft artifact",
    view: { blocks: [{ id: "d", data: { binding: tId } }, { id: "h", html: { ref: draftArt, data_from: ["d"] } }] },
  });
  pinnedMdView = await create({
    title: "Pinned Md View",
    type: "view",
    content: "pins",
    view: {
      blocks: [
        { id: "p2", md: { ref: docId, version: 2 } },
        { id: "p1", md: { ref: docId, version: 1 } },
        { id: "gone", md: { ref: "nodes/retracted-doc" } },
        { id: "frag", md: { ref: "nodes/fragile-doc" } },
        { id: "h", html: { ref: aId, data_from: ["p2", "p1", "gone", "frag"] } },
      ],
    },
  });
  await patch("nodes/retracted-doc", { status: "rejected" });
  // Simulated history read failure: the fragile doc's version chain is gone.
  const nestDir = join(env.dataDir, "nests", nestId);
  const victims: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) {
        if (f.includes("fragile-doc")) victims.push(p);
        else walk(p);
      } else if (f.includes("fragile-doc") && !p.endsWith(join("nodes", "fragile-doc.md"))) {
        victims.push(p);
      }
    }
  };
  walk(nestDir);
  expect(victims.length, "fragile-doc history on disk").toBeGreaterThan(0);
  for (const v of victims) if (existsSync(v)) rmSync(v, { recursive: true, force: true });
}, 60000);

afterAll(() => env.cleanup());

describe("AC-1: the view page", () => {
  it("serves the resolved blocks under the page CSP, with exactly one sandboxed frame", async () => {
    const res = await get(page(vId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).not.toMatch(/(^|;)\s*sandbox\b/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-view-snapshot")).toBe("1");
    const body = await res.text();
    expect(body).toContain("The board, at a glance.");
    expect(body).toContain("Welcome to the board intro.");
    expect(body).toContain("Metric One");
    expect(body).toContain("Metric Two");
    expect(body).toContain("<td>r1</td>");
    expect(body).toContain("<td>Gamma</td>");
    expect(body).toContain("Numbers are preliminary");
    expect(body).toMatch(/kpi[^<]*not supported yet/i);
    const frames = body.match(/<iframe [^>]*>/g) || [];
    expect(frames.length).toBe(1);
    expect(frames[0]).toMatch(/^<iframe sandbox="allow-scripts allow-modals" src="[^"]*\/view\/blocks\/h\/hosted"/);
    // Server-escaped: the evil cell is text, not markup.
    expect(body).not.toContain("<script");
    expect(body).toContain("&lt;/script&gt;");
  });
});

describe("AC-2 / AC-3 / AC-4: the html-block frame", () => {
  it("injects exactly one nest-data, after the doctype and before the app script", async () => {
    const res = await get(frame(vId, "h"));
    expect(res.status).toBe(200);
    const body = await res.text();
    const nd = nestData(body);
    expect(nd.count).toBe(1);
    expect(body.startsWith("<!doctype html>")).toBe(true);
    expect(body.indexOf('id="nest-data"')).toBeLessThan(body.indexOf("<script>/*app*/"));
    expect(Object.keys(nd.json)).toEqual(["d", "m"]);
    expect(nd.json.d.ok).toBe(true);
    expect(nd.json.d.rows).toEqual(T_ROWS);
    expect(nd.json.m.items.map((i: any) => i.title).sort()).toEqual(["Metric One", "Metric Two"]);
    // The artifact bytes are otherwise untouched, and no bridge rides along.
    expect(body.replace(/<script type="application\/json" id="nest-data">[\s\S]*?<\/script>/, "").trim()).toBe(ART_HTML);
    expect(body).not.toContain("data-cn-bridge");
  });

  it("AC-3: CSP is the no-popups sandbox (+ frame-ancestors), private no-store, nosniff, no-referrer", async () => {
    const res = await get(frame(vId, "h"));
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toBe(mergeFrameAncestors(ARTIFACT_SANDBOX_CSP_NO_POPUPS, "frame-ancestors 'self'"));
    expect(csp).toContain("sandbox allow-scripts allow-modals");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("allow-popups");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-view-snapshot")).toBe("1");
    // M8: the existing constant still carries allow-popups.
    expect(ARTIFACT_SANDBOX_CSP).toContain("allow-popups");
    expect(ARTIFACT_SANDBOX_CSP_NO_POPUPS).toBe(ARTIFACT_SANDBOX_CSP.replace(" allow-popups", ""));
  });

  it("AC-4: a </script> + U+2028 cell is escaped and round-trips", async () => {
    const body = await (await get(frame(vId, "h"))).text();
    const { raw, json } = nestData(body);
    expect(raw).not.toContain("<");
    expect(raw).not.toContain("\u2028");
    expect(raw).toContain("\\u2028");
    expect(json.d.rows[1].label).toBe(EVIL);
  });
});

describe("AC-5: caps", () => {
  it("600 rows → 500 and truncated", async () => {
    const res = await get(frame(bigView, "h"));
    expect(res.status).toBe(200);
    const { json } = nestData(await res.text());
    expect(json.six.rows.length).toBe(CAPS.MAX_ROWS);
    expect(json.six.truncated).toBe(true);
  });

  it("fat rows cap each entry at 256 KiB, and the payload at 1 MiB with later entries too_large", async () => {
    const res = await get(frame(bigView, "hf"));
    expect(res.status).toBe(200);
    const { json, raw } = nestData(await res.text());
    expect(Object.keys(json)).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    expect(json.f1.ok).toBe(true);
    expect(json.f1.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(json.f1))).toBeLessThanOrEqual(CAPS.MAX_BLOCK_BYTES);
    expect(json.f5).toEqual({ ok: false, kind: "data", error: "too_large" });
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(CAPS.MAX_NEST_DATA_BYTES);
  });
});

describe("AC-7: approval gates the data, not the page", () => {
  it("a draft-only view renders, and every frame entry is withheld", async () => {
    const res = await get(page(draftViewId));
    expect(res.status).toBe(200);
    const f = await get(frame(draftViewId, "h"));
    expect(f.status).toBe(200);
    const { json } = nestData(await f.text());
    expect(json).toEqual({
      d: { ok: false, kind: "data", error: "withheld" },
      m: { ok: false, kind: "list", error: "withheld" },
    });
  });

  it("?v=N of an unapproved version (as a member) withholds too", async () => {
    await selfApprove(false);
    try {
      const edited = await patch(vId, { content: "The board, edited." });
      const v = edited.version as number;
      expect(v).toBeGreaterThan(1);
      const res = await get(page(vId, `?v=${v}`));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("The board, edited.");
      const f = await get(frame(vId, "h", `?v=${v}`));
      expect(f.status).toBe(200);
      const { json } = nestData(await f.text());
      expect(Object.values(json).every((e: any) => e.error === "withheld")).toBe(true);
      // The default (approved) layout still serves data.
      const ok = nestData(await (await get(frame(vId, "h"))).text()).json;
      expect(ok.d.ok).toBe(true);
    } finally {
      await selfApprove(true);
    }
  });

  it("an approved view over an unapproved artifact withholds every entry", async () => {
    const f = await get(frame(draftArtViewId, "h"));
    expect(f.status).toBe(200);
    const { json } = nestData(await f.text());
    expect(json).toEqual({ d: { ok: false, kind: "data", error: "withheld" } });
  });
});

describe("AC-12: ?v=N pins the layout, data stays live", () => {
  it("v1's data_from with T's current rows, and X-View-Snapshot: 1", async () => {
    const latest = nestData(await (await get(frame(pinView, "h"))).text()).json;
    expect(Object.keys(latest)).toEqual(["m"]);
    await patch(tId, { content: `${T_CSV}\nr4,Delta,40` });
    const res = await get(frame(pinView, "h", "?v=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-view-snapshot")).toBe("1");
    const { json } = nestData(await res.text());
    expect(Object.keys(json)).toEqual(["d"]);
    expect(json.d.rows.map((r: any) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
    await patch(tId, { content: T_CSV });
  });
});

describe("AC-15: pinned and retracted md blocks", () => {
  it("a version that was a draft, a retracted node and a lost history are errors as data", async () => {
    const res = await get(frame(pinnedMdView, "h"));
    expect(res.status).toBe(200);
    const { json } = nestData(await res.text());
    expect(json.p2).toEqual({ ok: false, kind: "md", error: "not_published" });
    expect(json.p1.ok).toBe(true);
    expect(json.p1.kind).toBe("md");
    expect(json.p1.text.trim()).toBe("pinned v1");
    expect(json.gone).toEqual({ ok: false, kind: "md", error: "not_published" });
    expect(json.frag).toEqual({ ok: false, kind: "md", error: "history_error" });
  });

  it("the page renders nothing for the unpublished pin", async () => {
    const body = await (await get(page(pinnedMdView))).text();
    expect(body).toContain("pinned v1");
    expect(body).not.toContain("pinned v2 draft");
    expect(body).not.toContain("soon retracted");
  });
});

describe("AC-16: kill switch", () => {
  it("CN_VIEW_DATA=off withholds every entry and keeps the no-popups CSP", async () => {
    process.env.CN_VIEW_DATA = "off";
    try {
      const res = await get(frame(vId, "h"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).not.toContain("allow-popups");
      expect(res.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-modals");
      const { json } = nestData(await res.text());
      expect(Object.values(json).every((e: any) => e.error === "withheld")).toBe(true);
    } finally {
      delete process.env.CN_VIEW_DATA;
    }
  });
});

describe("AC-14: access errors", () => {
  it("a non-member gets 404 on both routes with no content", async () => {
    for (const p of [page(vId), frame(vId, "h")]) {
      const res = await get(p, stranger);
      expect(res.status, p).toBe(404);
      const text = await res.text();
      expect(text).not.toContain("Alpha");
      expect(text).not.toContain("nest-data");
    }
  });

  it("a traversal id is rejected", async () => {
    for (const p of [
      `/nests/${nestId}/nodes/nodes/../../x/view/hosted`,
      `/nests/${nestId}/nodes/nodes/%2e%2e/x/view/blocks/h/hosted`,
    ]) {
      const res = await get(p, owner);
      expect([400, 404], p).toContain(res.status);
      expect(await res.text()).not.toContain("nest-data");
    }
  });

  it("a non-view node is 404 on the page route; a non-html block is 404 on the frame route", async () => {
    expect((await get(page("nodes/intro"))).status).toBe(404);
    expect((await get(page(aId))).status).toBe(404);
    expect((await get(frame(vId, "d"))).status).toBe(404);
    expect((await get(frame(vId, "nope"))).status).toBe(404);
    expect((await get(frame(vId, "_b0"))).status).toBe(404);
  });

  it("a view whose audience excludes human is 404", async () => {
    expect((await get(page(agentView))).status).toBe(404);
  });

  it("?v=N of a version that does not exist is 404; a junk v falls back like /hosted", async () => {
    expect((await get(page(vId, "?v=999"))).status).toBe(404);
    expect((await get(page(vId, "?v=abc"))).status).toBe(200);
  });
});
