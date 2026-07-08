import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

// Import is now an upload: the browser reads the picked folder and POSTs each
// file's relative path + content. These build that payload in memory — there
// is no server-side folder to browse anymore.
type FileEntry = { path: string; content: string };
const mdFile = (path: string, frontmatter: string, body: string): FileEntry => ({
  path,
  content: `---\n${frontmatter}\n---\n${body}\n`,
});
const hasMd = (dir: string) =>
  readdirSync(dir, { recursive: true } as any).some((f: any) =>
    String(f).endsWith(".md"),
  );

describe("import folder as nest (upload model)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string };

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@test.com", "Alice");
  });

  afterAll(() => env.cleanup());

  it("rejects a missing name", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { files: [] },
      alice.apiKey,
    );
    expect(status).toBe(400);
  });

  it("writes uploaded files under DATA, edits under DATA, removes the copy on delete", async () => {
    const files = [mdFile("notes/first.md", "title: First\ntype: document", "hello")];
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "My Notes", files },
      alice.apiKey,
    );
    expect(status).toBe(201);
    expect(data.nest.is_imported).toBe(1);
    expect(data.documents).toBe(1);
    const nestId = data.nest.id;
    const dataNestDir = join(env.dataDir, "nests", nestId);
    // Uploaded file landed under DATA, structure preserved.
    expect(existsSync(join(dataNestDir, "notes", "first.md"))).toBe(true);

    // A new document also lands under DATA (not some external path).
    const { status: nodeStatus } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Second", content: "world" },
      alice.apiKey,
    );
    expect(nodeStatus).toBe(201);
    expect(
      readdirSync(dataNestDir, { recursive: true } as any).filter((f: any) =>
        String(f).endsWith(".md"),
      ).length,
    ).toBeGreaterThanOrEqual(2);

    // Delete removes the workspace copy.
    const { status: delStatus } = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}`,
      undefined,
      alice.apiKey,
    );
    expect(delStatus).toBe(200);
    expect(existsSync(dataNestDir)).toBe(false);
  });

  it("allows importing an empty folder, then creating a doc in it", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Empty", files: [] },
      alice.apiKey,
    );
    expect(status).toBe(201);
    expect(data.documents).toBe(0);
    const nestId = data.nest.id;

    const { status: nodeStatus } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Fresh", content: "body" },
      alice.apiKey,
    );
    expect(nodeStatus).toBe(201);
    expect(hasMd(join(env.dataDir, "nests", nestId))).toBe(true);
  });

  it("allows re-importing the same files as an independent copy", async () => {
    const files = [mdFile("doc.md", "title: Doc\ntype: document", "body")];
    const first = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Once", files },
      alice.apiKey,
    );
    const second = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Twice", files },
      alice.apiKey,
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.data.nest.id).not.toBe(first.data.nest.id);
  });

  it("ignores unsafe paths (traversal / absolute), keeps safe ones", async () => {
    const files = [
      { path: "../escape.md", content: "x" },
      { path: "/abs.md", content: "x" },
      mdFile("ok.md", "title: OK\ntype: document", "body"),
    ];
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Guarded", files },
      alice.apiKey,
    );
    expect(status).toBe(201);
    // Only ok.md is written + registered; the traversal/absolute entries are dropped.
    expect(data.documents).toBe(1);
    const dataNestDir = join(env.dataDir, "nests", data.nest.id);
    expect(existsSync(join(dataNestDir, "ok.md"))).toBe(true);
    // Nothing escaped the nest dir.
    expect(existsSync(join(dataNestDir, "..", "escape.md"))).toBe(false);
  });
});

describe("imported vault: discovery + registration", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string };
  let nestId: string;

  // Scattered real docs (root + topic folder), meta/agent files, and a
  // .versions history dir — like a vault authored by a flat/Obsidian tool.
  const files: FileEntry[] = [
    mdFile(
      "checking-approval-history.md",
      "title: Approval History\ntype: document\ntags: [history]\nversion: 3",
      "approved body",
    ),
    // Numeric title: YAML parses `title: 123` as a number; the API must coerce
    // it to a string so the editor's title.trim() doesn't crash.
    mdFile(
      "engineering/123.md",
      "title: 123\ntype: document\ntags: [eng]\nversion: 2",
      "eng body",
    ),
    // nodes/ exists (structured signal) but holds only meta.
    mdFile("nodes/INDEX.md", "title: Index\ntype: document", "index"),
    // Meta/agent files that must NOT surface as documents.
    mdFile("CLAUDE.md", "title: Claude", "agent config"),
    mdFile("CONTEXT.md", "title: Context", "vault identity"),
    mdFile("INDEX.md", "title: Root Index", "root index"),
    // Engine history — copied through, but skipped by discovery.
    mdFile(".versions/checking-approval-history/v1.md", "title: v1", "old version"),
  ];

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@test.com", "Alice");
  });

  afterAll(() => env.cleanup());

  it("discovers real docs anywhere, skips meta + hidden, publishes them", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Scattered Vault", files },
      alice.apiKey,
    );
    expect(status).toBe(201);
    // Two real docs registered. INDEX.md, CLAUDE.md, CONTEXT.md, nodes/INDEX.md
    // and .versions/* are excluded by flat discovery.
    expect(data.documents).toBe(2);
    nestId = data.nest.id;

    const { data: list } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      alice.apiKey,
    );
    const ids = list.nodes.map((n: any) => n.id).sort();
    expect(ids).toEqual(["checking-approval-history", "engineering/123"]);

    // Engine-published on import (no stewards → auto-approved), which bumps the
    // version by one: frontmatter version 2 → published version 3.
    const eng = list.nodes.find((n: any) => n.id === "engineering/123");
    expect(eng.status).toBe("published");
    expect(eng.version).toBe(3);
    expect(typeof eng.title).toBe("string");
    expect(eng.title).toBe("123");

    // Publish wrote a .versions history (keyframes for reconstructVersion), so
    // AI query/search and public-reader reconstruction work on imported docs.
    const dataNestDir = join(env.dataDir, "nests", nestId);
    expect(existsSync(join(dataNestDir, ".versions"))).toBe(true);
  });

  it("returns a string title from GET node even when frontmatter is numeric", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/engineering/123`,
      undefined,
      alice.apiKey,
    );
    expect(typeof data.node.title).toBe("string");
    expect(data.node.title).toBe("123");
  });

  it("titles a frontmatter-less file from its filename; a frontmatter title still wins", async () => {
    const files: FileEntry[] = [
      { path: "guides/getting-started.md", content: "# Heading\n\nbody" },
      { path: "a/b/c/deep-notes.md", content: "no frontmatter, nested" },
      mdFile("with-fm.md", "title: Explicit FM Title", "body"),
    ];
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Title From Filename", files },
      alice.apiKey,
    );
    expect(status).toBe(201);
    const nestId = data.nest.id;
    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      alice.apiKey,
    );
    const byId = Object.fromEntries(
      list.data.nodes.map((n: any) => [n.id, n.title]),
    );
    // Filename (leaf of the id), NOT the "# Heading" or an empty string.
    expect(byId["guides/getting-started"]).toBe("getting-started");
    expect(byId["a/b/c/deep-notes"]).toBe("deep-notes");
    // Explicit frontmatter title is untouched.
    expect(byId["with-fm"]).toBe("Explicit FM Title");
  });
});
