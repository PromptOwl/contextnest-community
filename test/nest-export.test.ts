/**
 * wdqcpzrtt2 — GET /nests/:id/export?format=markdown[&selector=].
 * Nest-level LLM-pointed plain-text view: accessible nodes serialized as
 * frontmatter + body, joined with `---` separators.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");
  const created = await jsonRequest(app, "POST", "/nests", {
    name: "Nest Export Test",
  });
  nestId = created.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Alpha Doc",
    content: "# Alpha\n\nalpha body",
    tags: ["x"],
  });
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Beta Doc",
    content: "# Beta\n\nbeta body",
    tags: ["y"],
  });
});

afterAll(() => env.cleanup());

describe("GET /nests/:id/export", () => {
  it("returns text/markdown concatenating nodes with --- separators", async () => {
    const res = await app.request(`/nests/${nestId}/export?format=markdown`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain('title: "Alpha Doc"');
    expect(text).toContain("alpha body");
    expect(text).toContain('title: "Beta Doc"');
    expect(text).toContain("beta body");
    // Two nodes → exactly one separator between them.
    expect(text.split("\n\n---\n\n").length).toBe(2);
  });

  it("narrows the set with a selector", async () => {
    const res = await app.request(
      `/nests/${nestId}/export?format=markdown&selector=${encodeURIComponent("#x")}`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Alpha Doc");
    expect(text).not.toContain("Beta Doc");
  });

  it("400s without format=markdown", async () => {
    const res = await app.request(`/nests/${nestId}/export`);
    expect(res.status).toBe(400);
  });
});
