/**
 * View write-back wiring on the view page (`…/view/hosted`).
 *
 * `write_to` is a layout field on an html block, validated by the engine's
 * view schema (3.5.0+). Everything here runs for real.
 *
 * AC covered here:
 *  - a block with write_to gets a bridge; a block without it, or a target not
 *    in it, gets nothing (the bridge refuses — see views-write-bridge.test.ts)
 *  - only an approved view version + approved artifact, written by members who
 *    can write, gets a bridge; a draft layout (?v=draft) never does
 *  - the frame CSP stays `connect-src 'none'`; /p never has a write path
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed, resetAuthRateLimit } from "./helpers.js";
import { ARTIFACT_SANDBOX_CSP_NO_POPUPS } from "../src/shared/artifact-sandbox.js";
import { WRITE_BRIDGE_JS, writeBridgeCspHash } from "../src/views/write.js";

type User = { apiKey: string; userId: string; email: string };

const ART_HTML = "<!doctype html><html><head><script>/*app*/</script></head><body></body></html>";
const T_CSV = "id:key,stage,amount:number\nr1,lead,10\nr2,won,20";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let editor: User;
let author: User;
let nestId: string;
let tId: string;
let t2Id: string;
let aId: string;
let vId: string;
let vDraftId: string;
let vByAuthor: string;
let authorCollabId: string;

const page = (viewId: string, q = "", who: User = editor) =>
  app.request(`/nests/${nestId}/nodes/${viewId}/view/hosted${q}`, { headers: authed(who.apiKey) });

function config(body: string): any {
  const m = /<script type="application\/json" id="cn-write-config">([\s\S]*?)<\/script>/.exec(body);
  return m ? JSON.parse(m[1]) : null;
}

async function mk(body: Record<string, unknown>, who: User = owner) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, who.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.node.id as string;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@wb.test", "Owner");
  editor = await registerUser(app, "editor@wb.test", "Editor");
  author = await registerUser(app, "author@wb.test", "Author");
  await resetAuthRateLimit();
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Write Back" }, owner.apiKey)).data.nest.id;
  await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true, allow_self_approve: true }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: editor.email, permission: "write" }, owner.apiKey);
  const ac = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: author.email, permission: "admin" }, owner.apiKey);
  authorCollabId = ac.data.collaborator.id;

  tId = await mk({ title: "Pipeline", type: "table", content: T_CSV });
  t2Id = await mk({ title: "Ledger", type: "table", content: "k:key,v\na,1" });
  aId = await mk({ title: "Board", type: "artifact", content: ART_HTML });
  const blocks = [
    { id: "d", data: { binding: tId } },
    { id: "e", data: { binding: t2Id } },
    { id: "c", callout: { text: "hello" } },
    // Only h writes (to d).
    { id: "h", html: { ref: aId, data_from: ["d"], write_to: ["d"] } },
    { id: "h2", html: { ref: aId, data_from: ["d"] } },
    { id: "h3", html: { ref: aId } },
  ];
  vId = await mk({ title: "Pipeline View", type: "view", content: "intro", view: { blocks } });
  vDraftId = await mk({ title: "Draft View", type: "view", content: "intro", view: { blocks } });
  // A view whose author later loses write access.
  vByAuthor = await mk({ title: "Author View", type: "view", content: "intro", view: { blocks } }, author);
}, 90000);

afterAll(() => env.cleanup());

describe("the page of a view with write_to", () => {
  it("ships the bridge under a hash-pinned CSP, with connect-src 'self' only", async () => {
    const res = await page(vId);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain(`script-src ${writeBridgeCspHash()}`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe-inline'; script");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    const body = await res.text();
    expect(body).toContain(`<script>${WRITE_BRIDGE_JS}</script>`);
    // One executable script only (the bridge); the config is inert JSON.
    expect((body.match(/<script>/g) || []).length).toBe(1);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("the config maps only write_to targets that are table data blocks, per frame", async () => {
    const body = await (await page(vId)).text();
    const cfg = config(body);
    expect(Object.keys(cfg.frames)).toEqual(["h"]);
    expect(cfg.frames.h.targets).toEqual({ d: `/nests/${encodeURIComponent(nestId)}/nodes/${tId}/rows` });
    expect(cfg.frames.h.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    // h2 and h3 have no write_to.
    expect(cfg.frames.h2).toBeUndefined();
    expect(cfg.frames.h3).toBeUndefined();
  });

  it("the engine refuses a write_to that names a non-data or unknown block", async () => {
    for (const writeTo of [["c"], ["zz"]]) {
      const blocks = [
        { id: "d", data: { binding: tId } },
        { id: "c", callout: { text: "hello" } },
        { id: "h", html: { ref: aId, write_to: writeTo } },
      ];
      const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: `Bad ${writeTo[0]}`, type: "view", content: "x", view: { blocks } }, owner.apiKey);
      expect(r.status, JSON.stringify(r.data)).toBe(400);
    }
  });

  it("each frame is addressable by its block id from the page's own markup", async () => {
    const body = await (await page(vId)).text();
    for (const id of ["h", "h2", "h3"]) expect(body).toContain(`data-cn-block="${id}"`);
  });

  it("the frame itself is unchanged: no-popups sandbox, connect-src 'none'", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/${vId}/view/blocks/h/hosted`, {
      headers: { ...authed(editor.apiKey), "Sec-Fetch-Dest": "iframe" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(`${ARTIFACT_SANDBOX_CSP_NO_POPUPS}; frame-ancestors 'self'`);
    const html = await res.text();
    expect(html).not.toContain("cn-write-config");
  });

  it("CN_VIEW_DATA=off or CN_VIEW_WRITES=off removes the bridge", async () => {
    for (const k of ["CN_VIEW_DATA", "CN_VIEW_WRITES"]) {
      process.env[k] = "off";
      try {
        const res = await page(vId);
        expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
        expect(await res.text()).not.toContain("cn-write-config");
      } finally {
        delete process.env[k];
      }
    }
  });
});

describe("frame token and artifact version pin (review round 1)", () => {
  const frameSrc = (body: string, id: string) =>
    new RegExp(`<iframe[^>]*src="([^"]+)"[^>]*data-cn-block="${id}"`).exec(body)![1].replace(/&amp;/g, "&");
  const tokenIn = (html: string) => {
    const m = /<script type="application\/json" id="nest-write-token">([\s\S]*?)<\/script>/.exec(html);
    return m ? JSON.parse(m[1]) : null;
  };
  const getFrame = (src: string) =>
    app.request(src, { headers: { ...authed(editor.apiKey), "Sec-Fetch-Dest": "iframe" } });

  it("a write frame's URL carries its token and the artifact version the page checked; the frame echoes the token", async () => {
    const body = await (await page(vId)).text();
    const cfg = config(body);
    const src = frameSrc(body, "h");
    const url = new URL(src, "http://x");
    expect(url.searchParams.get("wt")).toBe(cfg.frames.h.token);
    expect(Number(url.searchParams.get("av"))).toBeGreaterThan(0);
    const res = await getFrame(src);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(tokenIn(html)).toBe(cfg.frames.h.token);
    // Exactly one nest-data element still, and the token comes before it.
    expect((html.match(/id="nest-data"/g) || []).length).toBe(1);
    expect(html.indexOf("nest-write-token")).toBeLessThan(html.indexOf('id="nest-data"'));
  });

  it("a frame without write targets gets no token in its URL or body", async () => {
    const body = await (await page(vId)).text();
    const src = frameSrc(body, "h2");
    expect(src).not.toContain("wt=");
    expect(tokenIn(await (await getFrame(src)).text())).toBeNull();
  });

  it("no token when the served artifact version is not the one the page checked", async () => {
    const body = await (await page(vId)).text();
    const src = frameSrc(body, "h");
    const url = new URL(src, "http://x");
    url.searchParams.set("av", String(Number(url.searchParams.get("av")) + 1));
    const res = await getFrame(url.pathname + url.search);
    expect(res.status).toBe(200);
    expect(tokenIn(await res.text())).toBeNull();
  });

  it("a malformed token is not echoed", async () => {
    const body = await (await page(vId)).text();
    const url = new URL(frameSrc(body, "h"), "http://x");
    url.searchParams.set("wt", '"></script><script>alert(1)</script>');
    const html = await (await getFrame(url.pathname + url.search)).text();
    expect(tokenIn(html)).toBeNull();
    expect(html).not.toContain("alert(1)");
  });
});

describe("trust: only reviewed layouts and code written by writers", () => {
  it("a draft layout (?v=<draft>) never gets a bridge", async () => {
    const r = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${vDraftId}`, { content: "edited intro" }, editor.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.node.status).toBe("draft");
    const draft = r.data.version as number;
    const res = await page(vDraftId, `?v=${draft}`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("cn-write-config");
    // The approved layout still has it.
    expect(config(await (await page(vDraftId)).text())).not.toBeNull();
  });

  it("a view author who no longer has write access withdraws the bridge", async () => {
    expect(config(await (await page(vByAuthor)).text())).not.toBeNull();
    const down = await jsonRequest(app, "PATCH", `/nests/${nestId}/collaborators/${authorCollabId}`, { permission: "read" }, owner.apiKey);
    expect(down.status, JSON.stringify(down.data)).toBe(200);
    try {
      const res = await page(vByAuthor);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
      expect(await res.text()).not.toContain("cn-write-config");
    } finally {
      await jsonRequest(app, "PATCH", `/nests/${nestId}/collaborators/${authorCollabId}`, { permission: "admin" }, owner.apiKey);
    }
  });
});

describe("/p never accepts writes", () => {
  it("a published view's /p page has no frame, no script, no write config", async () => {
    const pub = await jsonRequest(app, "POST", `/nests/${nestId}/publications`, { node_id: vId, access_mode: "public" }, owner.apiKey);
    expect(pub.status, JSON.stringify(pub.data)).toBe(201);
    for (const suffix of ["", "/view"]) {
      const res = await app.request(`/p/${pub.data.publish.slug}${suffix}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain("<iframe");
      expect(body).not.toContain("cn-write-config");
      expect(body).not.toContain("nest-write");
    }
  });
});
