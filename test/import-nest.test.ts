import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, existsSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

describe("import folder as nest", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string };
  // A folder OUTSIDE DATA_ROOT — stands in for a user's existing directory.
  let externalDir: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@test.com", "Alice");
    externalDir = join(process.cwd(), "data", `external-${randomUUID()}`);
    mkdirSync(externalDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(externalDir, { recursive: true, force: true });
    } catch {}
    env.cleanup();
  });

  it("rejects a non-absolute path", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Bad", path: "relative/dir" },
      alice.apiKey,
    );
    expect(status).toBe(400);
  });

  it("rejects a path that does not exist", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Missing", path: join(externalDir, "nope") },
      alice.apiKey,
    );
    expect(status).toBe(400);
  });

  it("copies the folder into DATA, writes edits under DATA, removes the copy on delete", async () => {
    // Import
    const { status: importStatus, data: importData } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "My Notes", path: externalDir },
      alice.apiKey,
    );
    expect(importStatus).toBe(201);
    const nest = importData.nest;
    expect(nest.is_imported).toBe(1);
    const nestId = nest.id;
    const dataNestDir = join(env.dataDir, "nests", nestId);

    // A new document must land in the nest's DATA_ROOT copy, NOT back in the
    // user's original folder.
    const { status: nodeStatus } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "First", content: "hello world" },
      alice.apiKey,
    );
    expect(nodeStatus).toBe(201);

    const wroteUnderData = readdirSync(dataNestDir, { recursive: true } as any)
      .some((f: any) => String(f).endsWith(".md"));
    expect(wroteUnderData).toBe(true);

    // The user's original folder must NOT have gained the new doc — proof the
    // write went to the workspace copy, not the source.
    const wroteExternal = readdirSync(externalDir, { recursive: true } as any)
      .some((f: any) => String(f).endsWith(".md"));
    expect(wroteExternal).toBe(false);

    // Delete the nest → the DATA copy is removed, the user's original folder
    // survives untouched.
    const { status: delStatus } = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}`,
      undefined,
      alice.apiKey,
    );
    expect(delStatus).toBe(200);
    expect(existsSync(dataNestDir)).toBe(false);
    expect(existsSync(externalDir)).toBe(true);
  });

  it("allows re-importing the same folder as an independent copy", async () => {
    const dir = join(process.cwd(), "data", `external-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const first = await jsonRequest(
        app,
        "POST",
        "/nests/import",
        { name: "Once", path: dir },
        alice.apiKey,
      );
      expect(first.status).toBe(201);
      const second = await jsonRequest(
        app,
        "POST",
        "/nests/import",
        { name: "Twice", path: dir },
        alice.apiKey,
      );
      // Copy semantics: each import is its own workspace copy, so a second
      // import of the same source is a distinct nest, not a conflict.
      expect(second.status).toBe(201);
      expect(second.data.nest.id).not.toBe(first.data.nest.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fs browse endpoint", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string };
  let browseDir: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@test.com", "Alice");
    browseDir = join(process.cwd(), "data", `browse-${randomUUID()}`);
    mkdirSync(join(browseDir, "child-a"), { recursive: true });
    mkdirSync(join(browseDir, "child-b"), { recursive: true });
    mkdirSync(join(browseDir, ".hidden"), { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(browseDir, { recursive: true, force: true });
    } catch {}
    env.cleanup();
  });

  it("requires credentials in key mode", async () => {
    const { status } = await jsonRequest(app, "GET", "/fs/browse");
    expect(status).toBe(401);
  });

  it("lists subdirectories and skips hidden ones", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/fs/browse?path=${encodeURIComponent(browseDir)}`,
      undefined,
      alice.apiKey,
    );
    expect(status).toBe(200);
    expect(data.path).toBe(browseDir);
    const names = data.directories.map((d: any) => d.name);
    expect(names).toContain("child-a");
    expect(names).toContain("child-b");
    expect(names).not.toContain(".hidden");
    expect(data.parent).toBeTruthy();
  });
});

describe("imported folder document discovery + registration", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string };
  let vault: string;

  const writeDoc = (rel: string, frontmatter: string, body: string) => {
    const full = join(vault, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `---\n${frontmatter}\n---\n${body}\n`, "utf-8");
  };

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@test.com", "Alice");

    vault = join(process.cwd(), "data", `vault-${randomUUID()}`);
    // Scattered real docs (root + topic folder) — like a vault authored by
    // a flat/Obsidian tool, not the structured nodes/ layout.
    writeDoc("checking-approval-history.md", "title: Approval History\ntype: document\ntags: [history]\nversion: 3", "approved body");
    // Numeric title: YAML parses `title: 123` as a number — the API must
    // coerce it to a string so the editor's title.trim() doesn't crash.
    writeDoc("engineering/123.md", "title: 123\ntype: document\ntags: [eng]\nversion: 2", "eng body");
    // A nodes/ folder exists (structured signal) but holds only meta —
    // structured discovery would return 0 here.
    writeDoc("nodes/INDEX.md", "title: Index\ntype: document", "index");
    // Meta/agent files that must NOT surface as documents.
    writeDoc("CLAUDE.md", "title: Claude", "agent config");
    writeDoc("CONTEXT.md", "title: Context", "vault identity");
    writeDoc("INDEX.md", "title: Root Index", "root index");
    // Hidden dir must be skipped.
    writeDoc(".versions/checking-approval-history/v1.md", "title: v1", "old version");
  });

  afterAll(() => {
    try {
      rmSync(vault, { recursive: true, force: true });
    } catch {}
    env.cleanup();
  });

  it("discovers real docs anywhere, skips meta + hidden, and registers them", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Scattered Vault", path: vault },
      alice.apiKey,
    );
    expect(status).toBe(201);
    // Two real documents registered (root doc + engineering/123). INDEX.md,
    // CLAUDE.md, CONTEXT.md, nodes/INDEX.md and .versions/* are excluded.
    expect(data.documents).toBe(2);
    const nestId = data.nest.id;

    const { data: list } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      alice.apiKey,
    );
    const ids = list.nodes.map((n: any) => n.id).sort();
    expect(ids).toEqual(["checking-approval-history", "engineering/123"]);

    // Registered docs are engine-published on import (no stewards → auto-
    // approved, AI-ready), which bumps the on-disk version by one: the doc's
    // frontmatter version 2 becomes the published version 3.
    const eng = list.nodes.find((n: any) => n.id === "engineering/123");
    expect(eng.status).toBe("published");
    expect(eng.version).toBe(3);
    // Numeric YAML title coerced to string (else title.trim() crashes the editor).
    expect(typeof eng.title).toBe("string");
    expect(eng.title).toBe("123");

    // Engine publish ran on import: the DATA copy carries a .versions history
    // (keyframes for reconstructVersion) — the same artifact a normally-created
    // doc has, so AI query/search and public-reader reconstruction work on
    // imported docs too.
    const dataNestDir = join(env.dataDir, "nests", nestId);
    expect(existsSync(join(dataNestDir, ".versions"))).toBe(true);
  });

  it("returns a string title from GET node even when frontmatter is numeric", async () => {
    const imp = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Numeric Title Vault", path: vault },
      alice.apiKey,
    );
    // Re-import makes a second independent copy; either imported nest serves.
    const listAll = await jsonRequest(app, "GET", "/nests", undefined, alice.apiKey);
    const nestId = listAll.data.nests.find((n: any) => n.is_imported)?.id;
    const enc = "engineering/123";
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${enc}`,
      undefined,
      alice.apiKey,
    );
    expect(typeof data.node.title).toBe("string");
    void imp;
  });
});
