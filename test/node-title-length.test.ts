/**
 * Titles are bounded at 120 chars on create AND rename. The pre-existing
 * 100-char bound is on the *slug*, which a title of emoji or non-latin text
 * slips past entirely — leaving an unbounded string in frontmatter that
 * stretches every header rendering it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const n = await jsonRequest(app, "POST", "/nests", { name: "Alice Nest" }, alice.apiKey);
  nestId = n.data.nest.id;
});

afterAll(() => env.cleanup());

// 121 emoji: slugifies to "" so the slug bound never sees it.
const overlong = "🦉".repeat(121);

describe("title length bound", () => {
  it("rejects an overlong title on create", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: overlong, content: "body" },
      alice.apiKey,
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toMatch(/at most 120 characters/i);
  });

  it("accepts a long-but-legal title by truncating the derived id slug", async () => {
    // 119 chars of slug-safe text: under the 120 title cap, over the 100-char
    // path-segment bound. Must create, not 400.
    const title = `${"r".repeat(100)} ${"t".repeat(18)}`;
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title, content: "body" },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.title).toBe(title);
    const slug = String(res.data.node.id).split("/").pop()!;
    expect(slug.length).toBeLessThanOrEqual(100);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("accepts a title at the limit, and rejects a rename past it", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Ok Title", content: "body" },
      alice.apiKey,
    );
    expect(created.status).toBe(201);
    const nodeId = created.data.node.id;

    const atLimit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${encodeURIComponent(nodeId)}`,
      { title: "a".repeat(120) },
      alice.apiKey,
    );
    expect(atLimit.status).toBe(200);

    const tooLong = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${encodeURIComponent(nodeId)}`,
      { title: overlong },
      alice.apiKey,
    );
    expect(tooLong.status).toBe(400);
    expect(JSON.stringify(tooLong.data)).toMatch(/at most 120 characters/i);
  });

  it("lets a doc whose title predates the bound keep saving under that title", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Legacy Doc", content: "body" },
      alice.apiKey,
    );
    const nodeId = created.data.node.id;

    // Simulate a doc created before the bound existed: rewrite its stored
    // frontmatter title in place, bypassing the service entirely.
    const legacyTitle = "L".repeat(200);
    // Live doc only — NOT the .versions/ snapshot beside it.
    const file = join(env.dataDir, "nests", nestId, `${nodeId}.md`);
    const patched = readFileSync(file, "utf8").replace(
      /^title:.*$/m,
      `title: "${legacyTitle}"`,
    );
    expect(patched).toContain(legacyTitle);
    writeFileSync(file, patched);

    // Editing content resends the same long title — must not 400.
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${encodeURIComponent(nodeId)}`,
      { title: legacyTitle, content: "edited body" },
      alice.apiKey,
    );
    expect(res.status).toBe(200);

    // But renaming it to a *different* over-cap title is still refused.
    const rename = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${encodeURIComponent(nodeId)}`,
      { title: `${legacyTitle}X` },
      alice.apiKey,
    );
    expect(rename.status).toBe(400);
  });

  it("rejects a title with no slug-able characters, on create and on rename", async () => {
    // "###" slugifies to "" — the derived id was a bare `nodes/`, which wrote a
    // ghost at nodes/.md: absent from the list, unopenable, undeletable, and
    // colliding with the next symbols-only title.
    for (const title of ["###", "...", "!!!", "   "]) {
      const res = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title, content: "body" },
        alice.apiKey,
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.data)).toMatch(/at least one letter or number/i);
    }

    // Nothing was created, so the list is unchanged and a later create at the
    // same (empty) slug is not blocked.
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, alice.apiKey);
    expect(list.data.nodes.some((n: any) => n.id === `nodes/` || n.id.endsWith("/"))).toBe(false);

    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Renameable", content: "body" },
      alice.apiKey,
    );
    const rename = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${encodeURIComponent(created.data.node.id)}`,
      { title: "###" },
      alice.apiKey,
    );
    expect(rename.status).toBe(400);
    expect(JSON.stringify(rename.data)).toMatch(/at least one letter or number/i);
  });

  it("still projects the derived annotations node for an at-cap artifact title", async () => {
    // The derived title appends " — Annotations" (14 chars). Without bounding
    // the source title, an at-cap artifact pushes it past the limit and
    // createNode throws into syncAnnotationsNode's best-effort catch — the
    // projection silently never appears.
    const artifact = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "A".repeat(120),
        content: "<h1>deck</h1>",
        type: "artifact",
      },
      alice.apiKey,
    );
    expect(artifact.status).toBe(201);
    const artifactId = artifact.data.node.id;

    const thread = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${artifactId}/annotations`,
      { body: "needs a stronger close" },
      alice.apiKey,
    );
    expect(thread.status).toBe(201);

    const derivedId = `${artifactId}--annotations`;
    const derived = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${encodeURIComponent(derivedId)}`,
      undefined,
      alice.apiKey,
    );
    expect(derived.status).toBe(200);
    expect(derived.data.node.title.length).toBeLessThanOrEqual(120);
  });
});
