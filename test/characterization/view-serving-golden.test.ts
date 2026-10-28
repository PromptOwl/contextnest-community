/**
 * RC-19 / §2.9 — golden snapshot of every serving surface for NON-view nodes.
 *
 * Pins status, content-type, content-security-policy, x-content-type-options,
 * referrer-policy, x-artifact-snapshot, cache-control and the sha256 (+ length)
 * of the normalized body for:
 *   artifact: /hosted, /hosted?embed=1, /hosted?v=1, ?format=raw,
 *             ?format=raw&frontmatter=1, /p/:slug, /p/:slug/view
 *   document: /hosted (404), ?format=raw, ?format=raw&frontmatter=1,
 *             /p/:slug, /p/:slug/view
 * against test/characterization/__golden__/view-serving.json. Inputs are fixed
 * (titles, bodies, user, nest name). The view feature must leave every one of
 * these byte-identical; see golden.ts for the capture procedure.
 *
 * Every request is made twice and the two normalized snapshots must match,
 * so a run-to-run-varying token the normalizer missed shows up as a clear
 * in-run failure rather than a flaky golden.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
} from "../helpers.js";
import { ARTIFACT_SANDBOX_CSP } from "../../src/shared/artifact-sandbox.js";
import { Golden, makeNormalizer, snapResponse, type Normalizer } from "./golden.js";

// Fixed inputs — never change these without re-capturing the golden.
const NEST_NAME = "Golden Serving Nest";
const ART_TITLE = "Golden Artifact";
const ART_ID = "nodes/golden-artifact";
const ART_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Golden</title></head>' +
  '<body><h1>Golden Artifact</h1><p id="p">Fixed body.</p>' +
  '<script>document.getElementById("p").dataset.ok = "1";</script>' +
  "</body></html>";
const DOC_TITLE = "Golden Doc";
const DOC_ID = "nodes/golden-doc";
const DOC_MD = "# Golden Doc\n\nFixed body for the golden snapshot.\n\n- one\n- two";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let nestId: string;
let artSlug: string;
let docSlug: string;
let norm: Normalizer;
const golden = new Golden("view-serving");

async function get(path: string, withAuth: boolean) {
  return app.request(path, withAuth ? { headers: authed(owner.apiKey) } : {});
}

/** Fetch twice, require in-run determinism, return the snapshot + raw body. */
async function stableSnap(path: string, withAuth: boolean) {
  const a = await snapResponse(await get(path, withAuth), norm);
  const b = await snapResponse(await get(path, withAuth), norm);
  expect(b.snap, `non-deterministic response for ${path}`).toEqual(a.snap);
  return a;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@golden.test", "Golden Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: NEST_NAME }, owner.apiKey);
  expect(nest.status).toBe(201);
  nestId = nest.data.nest.id;

  const art = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: ART_TITLE, content: ART_HTML, type: "artifact" },
    owner.apiKey,
  );
  expect(art.status).toBe(201);
  expect(art.data.node.id).toBe(ART_ID);

  const doc = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: DOC_TITLE, content: DOC_MD, type: "document" },
    owner.apiKey,
  );
  expect(doc.status).toBe(201);
  expect(doc.data.node.id).toBe(DOC_ID);

  // No stewards → both auto-approved, so both can be published (the way
  // publish.test.ts / publish-branding.test.ts mint public links).
  const pa = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/publications`,
    { node_id: ART_ID, access_mode: "public" },
    owner.apiKey,
  );
  expect(pa.status).toBe(201);
  artSlug = pa.data.publish.slug;
  const pd = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/publications`,
    { node_id: DOC_ID, access_mode: "public" },
    owner.apiKey,
  );
  expect(pd.status).toBe(201);
  docSlug = pd.data.publish.slug;

  norm = makeNormalizer({
    NEST_ID: nestId,
    ART_SLUG: artSlug,
    DOC_SLUG: docSlug,
    OWNER_ID: owner.userId,
  });
});

afterAll(async () => {
  golden.flush();
  await env.cleanup();
});

describe("RC-19 golden — non-view artifact", () => {
  const base = () => `/nests/${nestId}/nodes/${ART_ID}`;

  it("/hosted", async () => {
    const { snap, body } = await stableSnap(`${base()}/hosted`, true);
    // Sanity independent of the golden (RC-1, RC-3).
    expect(snap.status).toBe(200);
    expect(body.trim()).toBe(ART_HTML);
    expect(body).not.toContain('id="nest-data"');
    expect(body).not.toContain("data-cn-bridge");
    expect(snap.csp!.startsWith(ARTIFACT_SANDBOX_CSP)).toBe(true);
    expect(snap.csp).toContain("connect-src 'none'");
    expect(snap.csp).toContain("default-src 'none'");
    golden.check("artifact /hosted", snap);
  });

  it("/hosted?embed=1", async () => {
    const { snap, body } = await stableSnap(`${base()}/hosted?embed=1`, true);
    expect(snap.status).toBe(200);
    expect(body.startsWith(ART_HTML)).toBe(true);
    expect(body.indexOf("data-cn-bridge")).toBeGreaterThan(body.indexOf("</html>"));
    expect(body).not.toContain('id="nest-data"');
    golden.check("artifact /hosted?embed=1", snap);
  });

  it("/hosted?v=1", async () => {
    const { snap, body } = await stableSnap(`${base()}/hosted?v=1`, true);
    expect(snap.status).toBe(200);
    expect(body.trim()).toBe(ART_HTML);
    expect(body).not.toContain('id="nest-data"');
    golden.check("artifact /hosted?v=1", snap);
  });

  it("?format=raw", async () => {
    const { snap, body } = await stableSnap(`${base()}?format=raw`, true);
    expect(snap.status).toBe(200);
    expect(body.trim()).toBe(ART_HTML);
    expect(body).not.toContain('id="nest-data"');
    // RC-5 parity with /hosted, checked again here on the golden fixture.
    const hosted = await get(`${base()}/hosted`, true);
    expect(snap.csp).toBe(norm(hosted.headers.get("content-security-policy") ?? ""));
    golden.check("artifact ?format=raw", snap);
  });

  it("?format=raw&frontmatter=1", async () => {
    const { snap, body } = await stableSnap(`${base()}?format=raw&frontmatter=1`, true);
    expect(snap.status).toBe(200);
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain("type: artifact");
    expect(body.trimEnd().endsWith(ART_HTML)).toBe(true);
    expect(body).not.toContain('id="nest-data"');
    const hosted = await get(`${base()}/hosted`, true);
    expect(snap.csp).toBe(norm(hosted.headers.get("content-security-policy") ?? ""));
    golden.check("artifact ?format=raw&frontmatter=1", snap);
  });

  it("/p/:slug", async () => {
    const { snap, body } = await stableSnap(`/p/${artSlug}`, false);
    expect(snap.status).toBe(200);
    expect(snap.csp!.startsWith(ARTIFACT_SANDBOX_CSP)).toBe(true);
    expect(body).toContain("Golden Artifact");
    expect(body).not.toContain('id="nest-data"');
    golden.check("artifact /p/:slug", snap);
  });

  it("/p/:slug/view", async () => {
    const { snap, body } = await stableSnap(`/p/${artSlug}/view`, false);
    expect(snap.status).toBe(200);
    expect(snap.csp!.startsWith(ARTIFACT_SANDBOX_CSP)).toBe(true);
    expect(body).toContain("Golden Artifact");
    expect(body).not.toContain('id="nest-data"');
    golden.check("artifact /p/:slug/view", snap);
  });
});

describe("RC-19 golden — ordinary document node", () => {
  const base = () => `/nests/${nestId}/nodes/${DOC_ID}`;

  it("/hosted (non-artifact → 404, RC-9)", async () => {
    const { snap } = await stableSnap(`${base()}/hosted`, true);
    expect(snap.status).toBe(404);
    golden.check("document /hosted", snap);
  });

  it("?format=raw", async () => {
    const { snap, body } = await stableSnap(`${base()}?format=raw`, true);
    expect(snap.status).toBe(200);
    expect(snap.csp).toBe("frame-ancestors 'self'");
    expect(body).toContain("Fixed body for the golden snapshot.");
    golden.check("document ?format=raw", snap);
  });

  it("?format=raw&frontmatter=1", async () => {
    const { snap, body } = await stableSnap(`${base()}?format=raw&frontmatter=1`, true);
    expect(snap.status).toBe(200);
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain("type: document");
    golden.check("document ?format=raw&frontmatter=1", snap);
  });

  it("/p/:slug", async () => {
    const { snap, body } = await stableSnap(`/p/${docSlug}`, false);
    expect(snap.status).toBe(200);
    expect(snap.csp!.startsWith(ARTIFACT_SANDBOX_CSP)).toBe(true);
    expect(body).toContain("Fixed body for the golden snapshot.");
    expect(body).not.toContain('id="nest-data"');
    golden.check("document /p/:slug", snap);
  });

  it("/p/:slug/view", async () => {
    const { snap, body } = await stableSnap(`/p/${docSlug}/view`, false);
    expect(snap.status).toBe(200);
    expect(snap.csp!.startsWith(ARTIFACT_SANDBOX_CSP)).toBe(true);
    expect(body).toContain("Fixed body for the golden snapshot.");
    golden.check("document /p/:slug/view", snap);
  });
});
