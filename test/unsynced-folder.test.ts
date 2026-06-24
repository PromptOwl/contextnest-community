import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

const writeMd = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body, "utf-8");
};

describe("unsynced folder discovery + sync", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string };

  beforeAll(async () => {
    env = setupTestEnv();
    // Open mode skips the admin-only gate on /nests/unsynced so a regular
    // registered user can drive the test against the real route surface.
    app = await createTestApp("open");
    alice = await registerUser(app, "alice@test.com", "Alice");

    // Seed a starter-like layout under DATA_ROOT.
    //   loose/                   — md at root → surfaced as "loose" leaf
    //   nodes/                   — no md at root, descend into subdirs:
    //     nodes/architecture/    — md → surfaced as "nodes/architecture"
    //     nodes/standards/       — md (nested) → surfaced as "nodes/standards"
    //   empty/                   — no md anywhere → skipped
    //   .hidden/                 — dot-prefixed → skipped
    //   nests/                   — reserved → skipped
    //   CONTEXT.md               — top-level file → skipped
    writeMd(join(env.dataDir, "loose", "doc-l.md"),
      "---\ntitle: Loose\ntype: document\n---\nloose body\n");
    writeMd(join(env.dataDir, "nodes", "architecture", "doc-a.md"),
      "---\ntitle: Doc A\ntype: document\n---\nbody a\n");
    writeMd(join(env.dataDir, "nodes", "standards", "doc-b.md"),
      "---\ntitle: Doc B\ntype: document\n---\nbody b\n");
    mkdirSync(join(env.dataDir, "empty"), { recursive: true });
    writeMd(join(env.dataDir, ".hidden", "secret.md"), "---\ntitle: x\n---\nx\n");
    writeMd(join(env.dataDir, "nests", "stray.md"), "x");
    writeFileSync(join(env.dataDir, "CONTEXT.md"), "context", "utf-8");
  });

  afterAll(() => env.cleanup());

  it("descends into subdirs when parent has no direct md", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      "/nests/unsynced",
      undefined,
      alice.apiKey,
    );
    expect(status).toBe(200);
    const names = data.folders.map((f: any) => f.name).sort();
    expect(names).toEqual([
      "loose",
      "nodes/architecture",
      "nodes/standards",
    ]);
    const arch = data.folders.find((f: any) => f.name === "nodes/architecture");
    expect(arch.label).toBe("architecture");
    expect(arch.mdCount).toBe(1);
  });

  it("rejects reserved + hidden folder names", async () => {
    for (const bad of ["nests", ".hidden", "../escape", "nodes/../escape"]) {
      const { status } = await jsonRequest(
        app,
        "POST",
        "/nests/unsynced/sync",
        { name: bad },
        alice.apiKey,
      );
      expect(status).toBe(400);
    }
  });

  it("syncs a nested leaf into a real nest, label drives the nest name", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/unsynced/sync",
      { name: "nodes/architecture" },
      alice.apiKey,
    );
    expect(status).toBe(201);
    expect(data.nest.is_imported).toBe(1);
    expect(data.nest.name).toBe("architecture");
    expect(data.documents).toBe(1);

    const nestId = data.nest.id;
    const nestDir = join(env.dataDir, "nests", nestId);
    expect(existsSync(join(nestDir, "doc-a.md"))).toBe(true);

    // Source leaf removed; sibling leaf (standards) still discoverable.
    expect(existsSync(join(env.dataDir, "nodes", "architecture"))).toBe(false);
    expect(existsSync(join(env.dataDir, "nodes", "standards"))).toBe(true);

    const { data: after } = await jsonRequest(
      app,
      "GET",
      "/nests/unsynced",
      undefined,
      alice.apiKey,
    );
    const remaining = after.folders.map((f: any) => f.name).sort();
    expect(remaining).toEqual(["loose", "nodes/standards"]);

    const { data: list } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      alice.apiKey,
    );
    expect(list.nodes.map((n: any) => n.id)).toEqual(["doc-a"]);
  });

  it("auto-suffixes when the leaf name collides with an existing nest", async () => {
    // Seed a fresh leaf with the same name as one already synced earlier.
    writeMd(
      join(env.dataDir, "more", "architecture", "doc-c.md"),
      "---\ntitle: Doc C\ntype: document\n---\nbody c\n",
    );

    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/unsynced/sync",
      { name: "more/architecture" },
      alice.apiKey,
    );
    expect(status).toBe(201);
    // Earlier test already created a nest called "architecture" — the second
    // sync of the same leaf name must not collide.
    expect(data.nest.name).toBe("architecture (1)");
  });

  it("404s when the folder does not exist", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      "/nests/unsynced/sync",
      { name: "nothing-here" },
      alice.apiKey,
    );
    expect(status).toBe(404);
  });
});
