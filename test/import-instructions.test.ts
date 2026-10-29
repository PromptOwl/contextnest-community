/**
 * A folder import keeps the folder's CONTEXT.md as the nest's instructions —
 * including a nest exported from ContextNest and imported back.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let apiKey: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  ({ apiKey } = await registerUser(app, "import@test.com", "Importer"));
});

afterAll(() => env.cleanup());

describe("imported CONTEXT.md", () => {
  it("becomes the imported nest's instructions", async () => {
    const files = [
      { path: "CONTEXT.md", content: "# Team rules\n\nAlways cite the source document.\n" },
      { path: "notes/alpha.md", content: "---\ntitle: Alpha\n---\n\n# Alpha\n" },
    ];
    const imp = await jsonRequest(app, "POST", "/nests/import", { name: "With Rules", files }, apiKey);
    expect(imp.status).toBe(201);
    const { data } = await jsonRequest(app, "GET", `/nests/${imp.data.nest.id}/instructions`, undefined, apiKey);
    expect(data.content).toContain("Always cite the source document.");
  });

  it("survives an export → re-import round trip", async () => {
    const src = (await jsonRequest(app, "POST", "/nests", { name: "Source" }, apiKey)).data.nest.id;
    const put = await jsonRequest(app, "PUT", `/nests/${src}/instructions`, { content: "# Source rules\n\nNever guess.\n" }, apiKey);
    expect(put.status).toBe(200);
    await jsonRequest(app, "POST", `/nests/${src}/nodes`, { title: "Beta", content: "# Beta" }, apiKey);
    const res = await app.request(`/nests/${src}/export?format=bundle`, { headers: { Authorization: `Bearer ${apiKey}` } });
    expect(res.status).toBe(200);
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await res.arrayBuffer());
    // Same filter the browser's expandZip applies.
    const files = [];
    for (const e of Object.values(zip.files)) {
      if (!e.dir && /\.(md|markdown|ya?ml|txt|json)$/i.test(e.name)) files.push({ path: e.name, content: await e.async("string") });
    }
    expect(files.map((f) => f.path)).toContain("CONTEXT.md");
    const imp = await jsonRequest(app, "POST", "/nests/import", { name: "Round Trip", files }, apiKey);
    expect(imp.status).toBe(201);
    const { data } = await jsonRequest(app, "GET", `/nests/${imp.data.nest.id}/instructions`, undefined, apiKey);
    expect(data.content).toContain("Never guess.");
  });

  it("survives the browser's chunked upload", async () => {
    const first = await jsonRequest(app, "POST", "/nests/import", {
      name: "Chunked Rules",
      partial: true,
      files: [{ path: "notes/alpha.md", content: "---\ntitle: Alpha\n---\n\n# Alpha\n" }],
    }, apiKey);
    expect(first.status).toBe(201);
    const nestId = first.data.nest.id;
    const next = await jsonRequest(app, "POST", "/nests/import", {
      nestId,
      files: [{ path: "CONTEXT.md", content: "# Team rules\n\nAlways cite the source document.\n" }],
    }, apiKey);
    expect(next.status).toBe(200);
    expect((await jsonRequest(app, "POST", "/nests/import", { nestId, finalize: true }, apiKey)).status).toBe(200);
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/instructions`, undefined, apiKey);
    expect(data.content).toContain("Always cite the source document.");
  });
});
