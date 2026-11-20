/**
 * po-1444 — Slack connect checks setup readiness and explains each connect
 * failure. Slack shows its own error page for a redirect_uri it doesn't know
 * and never comes back, so the server must refuse before sending anyone there.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomBytes } from "crypto";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";
import { publicUrlProblem, PUBLIC_URL_SETTING } from "../src/surfaces/adapters/slack/manifest.js";

const BASE = "https://nest.ready.test";
let env: { cleanup: () => Promise<void> };
let app: any;
let root: { apiKey: string; email: string };
let bob: { apiKey: string; email: string };
let installId: string;
let cookie: string;

async function login(email: string) {
  const r = await app.request("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "testpass" }) });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

async function stateRows(): Promise<number> {
  const { getDb } = await import("../src/db/client.js");
  return Number(((await getDb().get("SELECT COUNT(*) AS n FROM surface_oauth_states")) as { n: number }).n);
}

beforeAll(async () => {
  Object.assign(process.env, {
    FEATURE_WORKFLOW_PLANE: "true",
    FEATURE_METACOGNITION: "true",
    FEATURE_SURFACES: "true",
    SURFACES_BUFFER_KEY: randomBytes(32).toString("base64"),
    PUBLIC_BASE_URL: BASE,
  });
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@ready.test"], ownerEmail: "lic@ready.test" });
  root = await registerUser(app, "root@ready.test", "Root Admin");
  await resetAuthRateLimit();
  bob = await registerUser(app, "bob@ready.test", "Bob Member");
  await resetAuthRateLimit();
  const nest = (await jsonRequest(app, "POST", "/nests", { name: "Ready Nest" }, root.apiKey)).data.nest.id;
  installId = (await jsonRequest(app, "POST", "/surfaces/slack/installs", { home_nest_id: nest }, root.apiKey)).data.install_id;
  await jsonRequest(app, "PUT", `/surfaces/slack/installs/${installId}/credentials`, { client_id: "cid", client_secret: "cs", signing_secret: "sig" }, root.apiKey);
  cookie = await login(root.email);
});

afterEach(() => {
  process.env.PUBLIC_BASE_URL = BASE;
});

afterAll(async () => {
  for (const k of ["FEATURE_WORKFLOW_PLANE", "FEATURE_METACOGNITION", "FEATURE_SURFACES", "SURFACES_BUFFER_KEY", "PUBLIC_BASE_URL"]) delete process.env[k];
  await env?.cleanup();
});

describe("publicUrlProblem", () => {
  it("accepts a public https address and names the setting for anything Slack can't reach", () => {
    expect(publicUrlProblem("https://nest.acme.com")).toBeNull();
    for (const bad of ["", "http://localhost:3838", "https://localhost", "https://10.0.0.5", "https://192.168.1.4:3838", "http://nest.acme.com"]) {
      const p = publicUrlProblem(bad);
      expect(p, bad).not.toBeNull();
      expect(p!.steps.join(" ")).toContain(PUBLIC_URL_SETTING);
    }
    expect(publicUrlProblem("http://localhost:3838")!.problem).toMatch(/localhost or private/);
    expect(publicUrlProblem("http://nest.acme.com")!.problem).toMatch(/only https/);
    expect(publicUrlProblem("")!.problem).toMatch(/no public base URL/);
  });
});

describe("OAuth start refuses before Slack when Slack can't reach this server", () => {
  it("a localhost base URL: no redirect to Slack, no state row, and a page that says how to fix it", async () => {
    process.env.PUBLIC_BASE_URL = "http://localhost:3838";
    const before = await stateRows();
    const r = await app.request(`/surfaces/slack/installs/${installId}/oauth/start`, { headers: { Cookie: cookie, Accept: "text/html" } });
    expect(r.status).toBe(422);
    expect(r.headers.get("location")).toBeNull();
    expect(await stateRows()).toBe(before);
    const html = await r.text();
    expect(html).toContain("http://localhost:3838");
    expect(html).toContain("How to fix it");
    expect(html).toContain("Server settings → Basic → Public base URL");
    expect(html).toContain('<a href="/settings">Open Server settings</a>');
  });

  it("an http base URL is refused too, and an API caller gets the steps as JSON", async () => {
    process.env.PUBLIC_BASE_URL = "http://nest.acme.com";
    const r = await app.request(`/surfaces/slack/installs/${installId}/oauth/start`, { headers: { Cookie: cookie, Accept: "application/json" } });
    expect(r.status).toBe(422);
    const body = await r.json();
    expect(body.message).toMatch(/only https/);
    expect(body.steps.length).toBeGreaterThan(0);
  });

  it("a public https base URL goes on to Slack", async () => {
    const r = await app.request(`/surfaces/slack/installs/${installId}/oauth/start`, { headers: { Cookie: cookie } });
    expect(r.status).toBe(302);
    expect(new URL(r.headers.get("location")!).searchParams.get("redirect_uri")).toBe(`${BASE}/surfaces/slack/oauth/callback`);
  });

  it("missing app credentials show a page in the browser, not raw JSON", async () => {
    const nest = (await jsonRequest(app, "POST", "/nests", { name: "No Creds Nest" }, root.apiKey)).data.nest.id;
    const bare = (await jsonRequest(app, "POST", "/surfaces/slack/installs", { home_nest_id: nest }, root.apiKey)).data.install_id;
    const r = await app.request(`/surfaces/slack/installs/${bare}/oauth/start`, { headers: { Cookie: cookie, Accept: "text/html" } });
    expect(r.status).toBe(409);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(await r.text()).toMatch(/Client ID, Client secret and Signing secret/);
  });
});

describe("the callback explains Slack's own error", () => {
  it("access_denied: the person cancelled, nothing was connected", async () => {
    const r = await app.request(`/surfaces/slack/oauth/callback?error=access_denied&state=x`, { headers: { Cookie: cookie, Accept: "text/html" } });
    expect(r.status).toBe(400);
    const html = await r.text();
    expect(html).toContain("You cancelled the install in Slack. Nothing was connected.");
    expect(html).toContain('<a href="/control-room?section=setup">Back to Setup</a>');
  });

  it("any other code is named, with the redirect URL to check", async () => {
    const r = await app.request(`/surfaces/slack/oauth/callback?error=invalid_scope`, { headers: { Cookie: cookie, Accept: "application/json" } });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.message).toContain("Slack returned an error: invalid_scope.");
    expect(body.message).toContain(`${BASE}/surfaces/slack/oauth/callback`);
  });
});

describe("/surfaces/status readiness", () => {
  it("server admins get the checklist; booleans only, never a secret", async () => {
    const r = await jsonRequest(app, "GET", "/surfaces/status", undefined, root.apiKey);
    expect(r.data.readiness).toEqual({
      public_url: null,
      redirect_url: `${BASE}/surfaces/slack/oauth/callback`,
      buffer_key: true,
      model_key: expect.any(Boolean),
    });
    expect(JSON.stringify(r.data)).not.toContain(process.env.SURFACES_BUFFER_KEY!);
  });

  it("a missing buffer key and a localhost URL show as not ready", async () => {
    const key = process.env.SURFACES_BUFFER_KEY;
    delete process.env.SURFACES_BUFFER_KEY;
    process.env.PUBLIC_BASE_URL = "http://localhost:3838";
    try {
      const r = await jsonRequest(app, "GET", "/surfaces/status", undefined, root.apiKey);
      expect(r.data.readiness.buffer_key).toBe(false);
      expect(r.data.readiness.public_url.problem).toMatch(/localhost/);
    } finally {
      process.env.SURFACES_BUFFER_KEY = key;
    }
  });

  it("someone who isn't a server admin gets no readiness", async () => {
    const r = await jsonRequest(app, "GET", "/surfaces/status", undefined, bob.apiKey);
    expect(r.status).toBe(200);
    expect(r.data.readiness).toBeUndefined();
  });
});
