/**
 * Regression pins for view write-back (Engineering Ops task
 * `community-nest-views-write-rows-back-to-tables-as-governed-drafts`).
 *
 * Written and run green on the #440 base BEFORE any write-back code, so they
 * prove the feature leaves what exists alone:
 *  - a view page with no `write_to` keeps `script-src 'none'`, ships no script
 *    and its frames carry no extra attributes;
 *  - an html-block frame keeps the no-popups sandbox CSP, `connect-src 'none'`
 *    and `private, no-store`;
 *  - plain table body edits (PATCH content) publish on an ungoverned nest,
 *    draft for an editor on a governed nest, and honour X-Base-Version.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, authed, resetAuthRateLimit } from "./helpers.js";
import { ARTIFACT_SANDBOX_CSP_NO_POPUPS } from "../src/shared/artifact-sandbox.js";

type User = { apiKey: string; userId: string; email: string };

const ART_HTML = "<!doctype html><html><head><script>/*app*/</script></head><body></body></html>";
const T_CSV = "id:key,stage,amount:number\nr1,lead,10\nr2,won,20";
const PAGE_CSP_TODAY =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let editor: User;
let openNest: string;
let govNest: string;
let tOpen: string;
let tGov: string;
let vOpen: string;

async function mk(nestId: string, body: Record<string, unknown>, who: User = owner) {
  const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, who.apiKey);
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data.node.id as string;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@wb-reg.test", "Owner");
  editor = await registerUser(app, "editor@wb-reg.test", "Editor");
  await resetAuthRateLimit();

  openNest = (await jsonRequest(app, "POST", "/nests", { name: "Open" }, owner.apiKey)).data.nest.id;
  govNest = (await jsonRequest(app, "POST", "/nests", { name: "Gov" }, owner.apiKey)).data.nest.id;
  await jsonRequest(app, "PATCH", `/nests/${govNest}/settings`, { stewardship_enabled: true, allow_self_approve: true }, owner.apiKey);
  for (const n of [openNest, govNest]) {
    const c = await jsonRequest(app, "POST", `/nests/${n}/collaborators`, { email: editor.email, permission: "write" }, owner.apiKey);
    expect(c.status).toBeLessThan(300);
  }

  tOpen = await mk(openNest, { title: "Pipeline", type: "table", content: T_CSV });
  const aOpen = await mk(openNest, { title: "Board", type: "artifact", content: ART_HTML });
  vOpen = await mk(openNest, {
    title: "Pipeline View",
    type: "view",
    content: "intro",
    view: { blocks: [{ id: "d", data: { binding: tOpen } }, { id: "h", html: { ref: aOpen, data_from: ["d"] } }] },
  });
  tGov = await mk(govNest, { title: "Pipeline", type: "table", content: T_CSV });
});

afterAll(() => env.cleanup());

describe("regression: view page and frame headers", () => {
  it("a view page without write_to keeps script-src 'none' and ships no script", async () => {
    const res = await app.request(`/nests/${openNest}/nodes/${vOpen}/view/hosted`, { headers: authed(owner.apiKey) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP_TODAY);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    expect(body).not.toContain("<script");
    expect(body).not.toContain("data-cn-block");
    expect(body).toMatch(/<iframe sandbox="allow-scripts allow-modals" src="[^"]+" class="cn-frame" title="Embedded page" loading="lazy" referrerpolicy="no-referrer"><\/iframe>/);
  });

  it("an html-block frame keeps the no-popups sandbox and connect-src 'none'", async () => {
    const res = await app.request(`/nests/${openNest}/nodes/${vOpen}/view/blocks/h/hosted`, {
      headers: { ...authed(owner.apiKey), "Sec-Fetch-Dest": "iframe" },
    });
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toBe(`${ARTIFACT_SANDBOX_CSP_NO_POPUPS}; frame-ancestors 'self'`);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("allow-same-origin");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("regression: plain table body edits", () => {
  it("publishes directly on an ungoverned nest", async () => {
    const r = await jsonRequest(app, "PATCH", `/nests/${openNest}/nodes/${tOpen}`, { content: `${T_CSV}\nr3,lead,5` }, editor.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    const got = await jsonRequest(app, "GET", `/nests/${openNest}/nodes/${tOpen}`, undefined, owner.apiKey);
    expect(got.data.node.content).toContain("r3,lead,5");
    expect(got.data.node.status).toBe("published");
  });

  it("refuses a stale X-Base-Version with 409", async () => {
    const res = await app.request(`/nests/${openNest}/nodes/${tOpen}`, {
      method: "PATCH",
      headers: { ...authed(owner.apiKey), "Content-Type": "application/json", "X-Base-Version": "1" },
      body: JSON.stringify({ content: T_CSV }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.current_version).toBeGreaterThan(1);
  });

  it("drafts an editor's edit on a governed nest and leaves the approved version alone", async () => {
    const before = await jsonRequest(app, "GET", `/nests/${govNest}/nodes/${tGov}/versions`, undefined, owner.apiKey);
    expect(before.status).toBe(200);
    const r = await jsonRequest(app, "PATCH", `/nests/${govNest}/nodes/${tGov}`, { content: T_CSV.replace("r1,lead", "r1,won") }, editor.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.node.status).toBe("draft");
    const approved = await jsonRequest(app, "GET", `/nests/${govNest}/nodes/${tGov}?approved_only=1`, undefined, owner.apiKey);
    expect(approved.status).toBe(200);
    expect(approved.data.node.content.trimEnd()).toBe(T_CSV);
  });
});
