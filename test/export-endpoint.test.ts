/**
 * GET /nests/:id/nodes/:nodeId?format=markdown — LLM-pointed plain-text view.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let nodeId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");
  const created = await jsonRequest(app, "POST", "/nests", {
    name: "Export Test Nest",
  });
  nestId = created.data.nest.id;
  const node = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Export Me",
    content: "# Hello\n\nThe body text.",
    tags: ["alpha", "beta"],
  });
  nodeId = node.data.node.id;
});

afterAll(() => env.cleanup());

describe("node ?format=markdown export", () => {
  it("returns text/markdown with YAML frontmatter + body", async () => {
    const res = await app.request(
      `/nests/${nestId}/nodes/${nodeId}?format=markdown`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text.startsWith("---")).toBe(true);
    expect(text).toContain('title: "Export Me"');
    expect(text).toMatch(/tags: \[.*alpha.*beta.*\]/);
    expect(text).toContain("The body text.");
  });

  it("still returns JSON without the format param", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/${nodeId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("404s for a missing node", async () => {
    const res = await app.request(
      `/nests/${nestId}/nodes/nodes/does-not-exist?format=markdown`,
    );
    expect(res.status).toBe(404);
  });
});
