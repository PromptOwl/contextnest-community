/**
 * Per-nest image assets: multipart upload (write-tier) + immutable serving
 * (read-tier). Uuid-only filenames are the traversal defense; SVG is
 * excluded v1 (stored-XSS surface).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let reader: { apiKey: string; userId: string; email: string };
let nestId: string;
let assetUrl: string;

// 1x1 transparent PNG.
const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (ch) => ch.charCodeAt(0),
);

function upload(name: string, key: string, bytes: Uint8Array = PNG_BYTES) {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: "image/png" }));
  return app.request(`/nests/${nestId}/assets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  reader = await registerUser(app, "reader@acme.com", "Reader");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Pics" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: reader.email, permission: "read" },
    owner.apiKey,
  );
});

afterAll(() => env.cleanup());

describe("asset upload", () => {
  it("stores an image and returns url + ready markdown", async () => {
    const res = await upload("diagram.png", owner.apiKey);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.url).toMatch(new RegExp(`^/nests/${nestId}/assets/[0-9a-f-]{36}\\.png$`));
    expect(data.markdown).toBe(`![diagram](${data.url})`);
    assetUrl = data.url;
  });

  it("rejects non-image extensions (svg included, v1)", async () => {
    for (const name of ["payload.svg", "notes.html", "run.sh"]) {
      const res = await upload(name, owner.apiKey);
      expect(res.status).toBe(400);
    }
  });

  it("read-tier callers cannot upload", async () => {
    const res = await upload("sneaky.png", reader.apiKey);
    expect(res.status).toBe(403);
  });
});

describe("asset serving", () => {
  it("serves the bytes with content-type + immutable caching to read tier", async () => {
    const res = await app.request(assetUrl, {
      headers: { Authorization: `Bearer ${reader.apiKey}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBe(PNG_BYTES.length);
  });

  it("rejects non-uuid asset names (traversal shape never reaches the fs)", async () => {
    const res = await app.request(
      `/nests/${nestId}/assets/..%2F..%2Fcommunity.db`,
      { headers: { Authorization: `Bearer ${owner.apiKey}` } },
    );
    expect([400, 404]).toContain(res.status);
  });

  it("404s for a well-formed but missing asset", async () => {
    const res = await app.request(
      `/nests/${nestId}/assets/00000000-0000-4000-8000-000000000000.png`,
      { headers: { Authorization: `Bearer ${owner.apiKey}` } },
    );
    expect(res.status).toBe(404);
  });
});
