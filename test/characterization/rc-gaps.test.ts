/**
 * Characterization of regression-contract items whose existing tests only
 * check part of the stated property. Each test names its RC id.
 *
 *   RC-3  /hosted CSP is EXACTLY ARTIFACT_SANDBOX_CSP + the global
 *         frame-ancestors guard, and the sandbox keeps allow-popups
 *         (existing tests only check `toContain`).
 *   RC-4  X-Artifact-Snapshot is the served version, ?v=N echoes N, and the
 *         default moves to the newest approved version after a re-gen
 *         (existing test only checks the header is > 0).
 *   RC-10 a non-member gets 404 on PLAIN /hosted too (existing test covers
 *         embed=1 only).
 *   RC-11 a headless access key gets 403 headless_reader on /hosted through
 *         the real route (existing test is the pure verdict function).
 *   RC-5/6/7 no nest-data on any raw response, and nosniff + no-referrer on
 *         artifact raw with frontmatter=1 too.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
} from "../helpers.js";
import {
  ARTIFACT_SANDBOX_CSP,
  mergeFrameAncestors,
} from "../../src/shared/artifact-sandbox.js";

const V1 = "<!doctype html><html><body><h1>Gap Deck</h1><p>version one</p></body></html>";
const V2 = "<!doctype html><html><body><h1>Gap Deck</h1><p>version two</p></body></html>";

describe("RC-3 / RC-4 / RC-5..7 / RC-10 (key mode, ungoverned nest)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string; email: string };
  let stranger: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let artId: string;
  let docId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@gaps.test", "Owner");
    stranger = await registerUser(app, "stranger@gaps.test", "Stranger");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Gaps" }, owner.apiKey);
    nestId = nest.data.nest.id;
    const art = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Gap Deck", content: V1, type: "artifact" },
      owner.apiKey,
    );
    expect(art.status).toBe(201);
    artId = art.data.node.id;
    const doc = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Gap Doc", content: "# gap doc" },
      owner.apiKey,
    );
    docId = doc.data.node.id;
  });

  afterAll(() => env.cleanup());

  it("RC-3: the sandbox constant keeps allow-scripts, allow-popups, allow-modals and the no-network directives", () => {
    expect(ARTIFACT_SANDBOX_CSP).toContain("sandbox allow-scripts allow-popups allow-modals");
    expect(ARTIFACT_SANDBOX_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_SANDBOX_CSP).toContain("connect-src 'none'");
  });

  it("RC-3: /hosted (plain and embed=1) serves exactly the sandbox policy + frame-ancestors guard", async () => {
    const expected = mergeFrameAncestors(ARTIFACT_SANDBOX_CSP, "frame-ancestors 'self'");
    for (const q of ["", "?embed=1"]) {
      const res = await app.request(`/nests/${nestId}/nodes/${artId}/hosted${q}`, {
        headers: authed(owner.apiKey),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy"), `hosted${q}`).toBe(expected);
    }
  });

  it("RC-5/6/7: raw (with and without frontmatter) — parity CSP, nosniff, no-referrer, no nest-data", async () => {
    const hosted = await app.request(`/nests/${nestId}/nodes/${artId}/hosted`, {
      headers: authed(owner.apiKey),
    });
    const hostedCsp = hosted.headers.get("content-security-policy");
    for (const q of ["?format=raw", "?format=raw&frontmatter=1"]) {
      const res = await app.request(`/nests/${nestId}/nodes/${artId}${q}`, {
        headers: authed(owner.apiKey),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy"), q).toBe(hostedCsp);
      expect(res.headers.get("x-content-type-options"), q).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), q).toBe("no-referrer");
      expect(await res.text()).not.toContain('id="nest-data"');
    }
    const docRaw = await app.request(`/nests/${nestId}/nodes/${docId}?format=raw`, {
      headers: authed(owner.apiKey),
    });
    expect(docRaw.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(await docRaw.text()).not.toContain('id="nest-data"');
  });

  it("RC-10: a non-member gets 404 on plain /hosted and on ?format=raw, with no artifact bytes", async () => {
    for (const path of [
      `/nests/${nestId}/nodes/${artId}/hosted`,
      `/nests/${nestId}/nodes/${artId}?format=raw`,
    ]) {
      const res = await app.request(path, { headers: authed(stranger.apiKey) });
      expect([403, 404], path).toContain(res.status);
      if (path.endsWith("/hosted")) expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("version one");
    }
  });

  // Runs last in this describe: it re-generates the artifact.
  it("RC-4: X-Artifact-Snapshot is the served version; ?v=N echoes N and stays frozen", async () => {
    const first = await app.request(`/nests/${nestId}/nodes/${artId}/hosted`, {
      headers: authed(owner.apiKey),
    });
    const v1 = first.headers.get("x-artifact-snapshot");
    expect(v1).toMatch(/^[1-9]\d*$/);
    expect(await first.text()).toContain("version one");

    const pinned1 = await app.request(`/nests/${nestId}/nodes/${artId}/hosted?v=${v1}`, {
      headers: authed(owner.apiKey),
    });
    expect(pinned1.status).toBe(200);
    expect(pinned1.headers.get("x-artifact-snapshot")).toBe(v1);

    const patched = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${artId}`,
      { content: V2 },
      owner.apiKey,
    );
    expect(patched.status).toBe(200);

    const latest = await app.request(`/nests/${nestId}/nodes/${artId}/hosted`, {
      headers: authed(owner.apiKey),
    });
    const v2 = latest.headers.get("x-artifact-snapshot");
    expect(Number(v2)).toBeGreaterThan(Number(v1));
    const latestHtml = await latest.text();
    expect(latestHtml).toContain("version two");
    expect(latestHtml).not.toContain("version one");

    const frozen = await app.request(`/nests/${nestId}/nodes/${artId}/hosted?v=${v1}`, {
      headers: authed(owner.apiKey),
    });
    expect(frozen.headers.get("x-artifact-snapshot")).toBe(v1);
    const frozenHtml = await frozen.text();
    expect(frozenHtml.trim()).toBe(V1);
    // The frozen snapshot keeps the same CSP as the live one.
    expect(frozen.headers.get("content-security-policy")).toBe(
      latest.headers.get("content-security-policy"),
    );
  });
});

describe("RC-11: headless access key on /hosted (real route)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let artId: string;
  let readerKey: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { ownerEmail: "owner@headless-gap.test" });
    owner = await registerUser(app, "owner@headless-gap.test", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Headless Gap" }, owner.apiKey);
    nestId = nest.data.nest.id;
    const art = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Headless Deck", content: V1, type: "artifact" },
      owner.apiKey,
    );
    artId = art.data.node.id;
    const on = await jsonRequest(
      app,
      "PUT",
      `/nests/${nestId}/headless`,
      { enabled: true },
      owner.apiKey,
    );
    expect(on.status).toBe(200);
    const key = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/headless/keys`,
      { label: "Gap Reader" },
      owner.apiKey,
    );
    expect(key.status).toBe(201);
    readerKey = key.data.api_key;
  });

  afterAll(() => env.cleanup());

  it("is refused /hosted, /hosted?embed=1 and /hosted?v=1 with 403 headless_reader and no bytes", async () => {
    for (const q of ["", "?embed=1", "?v=1"]) {
      const res = await app.request(`/nests/${nestId}/nodes/${artId}/hosted${q}`, {
        headers: authed(readerKey),
      });
      expect(res.status, `hosted${q}`).toBe(403);
      const text = await res.text();
      expect(JSON.parse(text).code, `hosted${q}`).toBe("headless_reader");
      expect(text).not.toContain("version one");
    }
  });
});
