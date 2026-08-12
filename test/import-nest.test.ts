import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
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

  it("publishes the whole batch under ONE checkpoint, not one per document", async () => {
    // The import registers docs through the engine's `context_import` operation
    // in a single batch. Publishing one-by-one is O(N²) — each publish seals its
    // own checkpoint and every checkpoint re-scans the whole vault — so a
    // per-doc checkpoint count is the regression signal for that loop coming back.
    // Explicitly published in the source: import only publishes what its author
    // marked publishable, so a status-less fixture would register 8 drafts and
    // seal no checkpoint at all — measuring nothing about batching.
    const files = Array.from({ length: 8 }, (_, i) =>
      mdFile(
        `batch/doc-${i}.md`,
        `title: Doc ${i}\ntype: document\nstatus: published`,
        `body ${i}`,
      ),
    );
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Batched", files },
      alice.apiKey,
    );
    expect(status).toBe(201);
    expect(data.documents).toBe(8);

    const history = readFileSync(
      join(env.dataDir, "nests", data.nest.id, ".versions", "context_history.yaml"),
      "utf-8",
    );
    expect(history.match(/^\s*- checkpoint:/gm) ?? []).toHaveLength(1);

    // Every doc is genuinely published, not just cheaply counted.
    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${data.nest.id}/nodes`,
      undefined,
      alice.apiKey,
    );
    expect(list.data.nodes).toHaveLength(8);
    expect(list.data.nodes.every((n: any) => n.status === "published")).toBe(true);
  });

  it("registers every doc when the import spans several read/write batches", async () => {
    // Discovery and the import prep both read/write in bounded-parallel batches
    // (32 at a time) so a network-backed vault mount doesn't pay one round trip
    // per document. 80 docs crosses that boundary three times: this catches a
    // batch fold that drops documents or scrambles their order.
    //
    // Every third doc is an explicit draft, interleaved rather than grouped, so
    // the drafts/pending split — which now happens after a batch settles rather
    // than per doc — has to survive the fold as well.
    const n = 80;
    const isDraft = (i: number) => i % 3 === 0;
    const files = Array.from({ length: n }, (_, i) =>
      mdFile(
        `wide/doc-${String(i).padStart(3, "0")}.md`,
        `title: Wide ${String(i).padStart(3, "0")}\ntype: document` +
          (isDraft(i) ? "\nstatus: draft" : "\nstatus: published"),
        `body ${i}`,
      ),
    );
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Wide", files },
      alice.apiKey,
    );
    expect(status).toBe(201);
    expect(data.documents).toBe(n);

    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${data.nest.id}/nodes`,
      undefined,
      alice.apiKey,
    );
    expect(list.data.nodes).toHaveLength(n);
    // Every id present exactly once — a mis-folded batch would duplicate or lose some.
    expect([...new Set(list.data.nodes.map((d: any) => d.id))]).toHaveLength(n);
    // Discovery order is still sorted by id, which is what the prep pass walks.
    const ids = list.data.nodes.map((d: any) => d.id);
    expect([...ids].sort()).toEqual(ids);
    // Each doc kept ITS OWN status: a fold that mixed the two partitions up
    // would publish a draft (or hold back a publishable doc) without changing
    // the counts, so assert per id rather than in aggregate.
    const statusById = new Map(
      list.data.nodes.map((d: any) => [d.id, d.status]),
    );
    for (let i = 0; i < n; i++) {
      expect(statusById.get(`wide/doc-${String(i).padStart(3, "0")}`)).toBe(
        isDraft(i) ? "draft" : "published",
      );
    }
  });

  it("re-registering skips tracked docs and picks up new ones across a batch", async () => {
    // Registration asks ONE query which docs the nest already tracks, then
    // prepares only the rest — replacing a per-doc lookup. This is the path that
    // optimisation exists for: a second pass over a nest holding a mix of
    // already-tracked and brand-new docs, straddling the batch boundary.
    const n = 50;
    const files = Array.from({ length: n }, (_, i) =>
      mdFile(
        `mixed/old-${String(i).padStart(3, "0")}.md`,
        `title: Old ${String(i).padStart(3, "0")}\ntype: document\nstatus: published`,
        `body ${i}`,
      ),
    );
    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Mixed", files },
      alice.apiKey,
    );
    const nestId = data.nest.id;
    expect(data.documents).toBe(n);

    // Land new markdown in the nest the way an out-of-band sync would, then
    // register again. Total (50 + 30) crosses the batch boundary; the fresh
    // slice alone does not, so a broken filter shows up as a count mismatch.
    const added = 30;
    for (let i = 0; i < added; i++) {
      const p = join(env.dataDir, "nests", nestId, "mixed", `new-${String(i).padStart(3, "0")}.md`);
      writeFileSync(
        p,
        `---\ntitle: New ${String(i).padStart(3, "0")}\ntype: document\nstatus: published\n---\n\nfresh ${i}\n`,
        "utf-8",
      );
    }

    const { registerImportedDocuments } = await import("../src/nodes/service.js");
    const registered = await registerImportedDocuments(nestId, "alice@test.com");
    // ONLY the new ones — the 50 already tracked must not register twice.
    expect(registered).toBe(added);

    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      alice.apiKey,
    );
    expect(list.data.nodes).toHaveLength(n + added);
    expect([...new Set(list.data.nodes.map((d: any) => d.id))]).toHaveLength(n + added);
    expect(list.data.nodes.every((d: any) => d.status === "published")).toBe(true);

    // A third pass has nothing left to do — the idempotency the bulk query owns.
    expect(await registerImportedDocuments(nestId, "alice@test.com")).toBe(0);
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
      "title: Approval History\ntype: document\ntags: [history]\nversion: 3\nstatus: published",
      "approved body",
    ),
    // Numeric title: YAML parses `title: 123` as a number; the API must coerce
    // it to a string so the editor's title.trim() doesn't crash.
    mdFile(
      "engineering/123.md",
      "title: 123\ntype: document\ntags: [eng]\nversion: 2\nstatus: published",
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

  it("publishes only what the source marked publishable, holds everything else", async () => {
    const files: FileEntry[] = [
      mdFile("ok.md", "title: Ok\nstatus: published", "publish me"),
      mdFile("appr.md", "title: Appr\nstatus: approved", "approved -> publish"),
      mdFile("plain.md", "title: Plain", "no status -> held as draft"),
      mdFile("wip.md", "title: Wip\nstatus: draft", "keep draft"),
      mdFile("bad.md", "title: Bad\nstatus: rejected", "keep unpublished"),
      mdFile("old.md", "title: Old\nstatus: superseded", "keep unpublished"),
      mdFile("pr.md", "title: PR\nstatus: pending_review", "awaiting review"),
      mdFile("rev.md", "title: Rev\nstatus: review", "alias of pending_review"),
    ];
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Governance States", files },
      alice.apiKey,
    );
    expect(status).toBe(201);
    // All register (none dropped), even the rejected one that the engine
    // would refuse to publish.
    expect(data.documents).toBe(8);
    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${data.nest.id}/nodes`,
      undefined,
      alice.apiKey,
    );
    const byId = Object.fromEntries(
      list.data.nodes.map((n: any) => [n.id, n.status]),
    );
    expect(byId["ok"]).toBe("published");
    expect(byId["appr"]).toBe("published"); // approved is publishable too
    // Publishing is opt-in: a file that states no status has consented to
    // nothing, so it is held for a human rather than served to an AI.
    expect(byId["plain"]).toBe("draft");
    expect(byId["wip"]).toBe("draft");
    expect(byId["bad"]).toBe("draft"); // rejected -> kept unpublished, not errored
    expect(byId["old"]).toBe("draft");
    expect(byId["pr"]).toBe("draft"); // pending_review -> kept unpublished
    expect(byId["rev"]).toBe("draft"); // 'review' alias normalizes to pending_review
  });

  it("edits an imported draft without a version collision (publish-in-place upsert)", async () => {
    // Import a doc that stays a draft — registration seeds a node_versions row
    // at its version.
    const files: FileEntry[] = [
      mdFile("draft-notes.md", "title: Draft Notes\nstatus: draft", "original body"),
    ];
    const imp = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Draft Edit", files },
      alice.apiKey,
    );
    expect(imp.status).toBe(201);
    const nestId = imp.data.nest.id;

    // Editing it auto-publishes (no stewards). The engine publishes the draft
    // IN PLACE — same version number — so the governance row already at that
    // version must be updated, not re-inserted. Before the upsert fix this 500'd
    // with UNIQUE(nest_id, node_id, version).
    const patch = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/draft-notes`,
      { content: "edited body", changeNote: "tweak" },
      alice.apiKey,
    );
    expect(patch.status).toBe(200);

    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      alice.apiKey,
    );
    const doc = list.data.nodes.find((n: any) => n.id === "draft-notes");
    expect(doc.status).toBe("published");
  });

  it("sets the importer as author, ignoring the vault's own author (no phantom collaborator)", async () => {
    const files: FileEntry[] = [
      mdFile("owned.md", "title: Owned\nstatus: published\nauthor: stranger@nowhere.com", "body"),
    ];
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Ownership", files },
      alice.apiKey,
    );
    expect(status).toBe(201);
    const { data: got } = await jsonRequest(
      app,
      "GET",
      `/nests/${data.nest.id}/nodes/owned`,
      undefined,
      alice.apiKey,
    );
    // Author is the importer, not the vault's frontmatter author.
    expect(got.node.author).toBe("alice@test.com");
    // No phantom collaborator from the author≠version-author mismatch.
    expect(got.node.collaborators ?? []).toEqual([]);
  });

  it("does not import a vault's _suggestions store (no phantom external edits)", async () => {
    const meta =
      "suggestion_id: sug-1\n" +
      "document_id: notes/idea\n" + // old-nest id, would be unresolvable here
      "source: out-of-band-edit\n" +
      "detected_at: '2026-01-01T00:00:00.000Z'\n" +
      "actor: someone@test.com\n" +
      "target_hash: sha256:" + "a".repeat(64) + "\n" +
      "proposed_hash: sha256:" + "b".repeat(64) + "\n";
    const files: FileEntry[] = [
      mdFile("notes/idea.md", "title: Idea\nstatus: published", "the doc body"),
      // Engine per-doc suggestion store — must be skipped on import.
      { path: "notes/_suggestions/idea/sug-1.meta.yaml", content: meta },
      { path: "notes/_suggestions/idea/sug-1.patch", content: "--- a\n+++ b\n" },
    ];
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "No Suggestions", files },
      alice.apiKey,
    );
    expect(status).toBe(201);
    // Only the doc registered; the two _suggestions files are not documents.
    expect(data.documents).toBe(1);
    const nestId = data.nest.id;
    // The suggestion store was not written to disk.
    expect(existsSync(join(env.dataDir, "nests", nestId, "notes", "_suggestions"))).toBe(false);
    // And the External Edits queue is empty — no phantom entries.
    const ee = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/external-edits`,
      undefined,
      alice.apiKey,
    );
    expect(ee.data.total).toBe(0);
  });

  it("routes external-edit approve to its own handler, not the review route", async () => {
    // Regression: greedy `/:nodeId{.+}/approve` (review) must not swallow
    // `.../external-edits/:suggestionId/approve`. A bogus suggestion id should
    // reach the external-edit handler (400), never the review route's
    // "No pending review for this node" (403).
    const imp = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Route Guard", files: [mdFile("doc.md", "title: D\nstatus: published", "body")] },
      alice.apiKey,
    );
    const nestId = imp.data.nest.id;
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/doc/external-edits/does-not-exist/approve`,
      {},
      alice.apiKey,
    );
    expect(res.data.error).not.toBe("No pending review for this node");
    expect(res.status).toBe(400);
  });

  // The browser uploads a large folder in bounded chunks instead of one body:
  // create-with-first-chunk, append, finalize. Registration must see every
  // chunk, and must not run until finalize.
  it("imports a folder uploaded in chunks", async () => {
    const first = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      {
        name: "Chunked",
        files: [mdFile("c1.md", "title: C1", "one")],
        partial: true,
      },
      alice.apiKey,
    );
    expect(first.status).toBe(201);
    const nestId = first.data.nest.id;
    // A partial first chunk registers nothing — the folder isn't complete yet.
    expect(first.data.documents).toBeUndefined();

    const second = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { nestId, files: [mdFile("c2.md", "title: C2", "two"), mdFile("sub/c3.md", "title: C3", "three")] },
      alice.apiKey,
    );
    expect(second.status).toBe(200);
    expect(second.data.written).toBe(2);

    const done = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { nestId, finalize: true },
      alice.apiKey,
    );
    expect(done.status).toBe(200);
    // All three chunked docs registered, including the nested one.
    expect(done.data.documents).toBe(3);
    expect(existsSync(join(env.dataDir, "nests", nestId, "sub", "c3.md"))).toBe(true);

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, alice.apiKey);
    expect(list.data.nodes.length).toBe(3);
  });

  it("counts docs the batch publish never touches when finalizing a chunked import", async () => {
    // Drafts never enter the publish batch; they still have to register.
    const first = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Chunked Mixed", files: [mdFile("p1.md", "title: P1", "publish me")], partial: true },
      alice.apiKey,
    );
    const nestId = first.data.nest.id;
    await jsonRequest(
      app,
      "POST",
      "/nests/import",
      {
        nestId,
        files: Array.from({ length: 5 }, (_, i) =>
          mdFile(`d${i}.md`, `title: D${i}\nstatus: draft`, "kept unpublished"),
        ),
      },
      alice.apiKey,
    );
    const done = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { nestId, finalize: true },
      alice.apiKey,
    );
    expect(done.data.documents).toBe(6);
  });

  it("refuses to append chunks to an import that has already been finalized", async () => {
    // Staging writes straight into vault storage, skipping the node-creation
    // path and its validation. That is the point mid-upload, but it must not
    // stay open afterwards as a raw-write door into any nest the caller owns.
    const first = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Closed Import", files: [mdFile("a.md", "title: A\nstatus: published", "one")] },
      alice.apiKey,
    );
    expect(first.status).toBe(201);
    expect(first.data.documents).toBe(1);
    const nestId = first.data.nest.id;

    const late = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { nestId, files: [mdFile("late.md", "title: Late", "sneaked in")] },
      alice.apiKey,
    );
    expect(late.status).toBe(400);
    expect(existsSync(join(env.dataDir, "nests", nestId, "late.md"))).toBe(false);
  });

  it("refuses to append chunks to a nest the caller does not own", async () => {
    // A continuation writes files straight into a nest's storage — anything
    // short of owner would let any caller inject documents into someone else's.
    const mallory = await registerUser(app, "mallory@test.com", "Mallory");
    const first = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Private Chunked", files: [mdFile("a.md", "title: A", "mine")], partial: true },
      alice.apiKey,
    );
    const nestId = first.data.nest.id;
    const res = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { nestId, files: [mdFile("evil.md", "title: Evil", "injected")] },
      mallory.apiKey,
    );
    expect(res.status).toBe(404);
    expect(existsSync(join(env.dataDir, "nests", nestId, "evil.md"))).toBe(false);
  });

  it("reports the files it refused instead of counting them as imported", async () => {
    // A traversal path is skipped, not fatal — but the caller has to be told,
    // or a partial import reads as a clean one.
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      {
        name: "Partly Unsafe",
        files: [
          mdFile("good.md", "title: Good\nstatus: published", "kept"),
          mdFile("../escape.md", "title: Escape", "rejected"),
        ],
      },
      alice.apiKey,
    );
    expect(status).toBe(201);
    expect(data.documents).toBe(1);
    expect(data.rejected).toEqual(["../escape.md"]);
  });

  it("recovers a doc whose imported version chain won't reconstruct", async () => {
    // A half-migrated vault: frontmatter claims version 3 with a history whose
    // v2 diff won't apply (context lines absent from the keyframe). As-is
    // publish throws "Failed to apply diff"; import must reset + republish.
    const badDiff =
      "Index: v1\n" +
      "===================================================================\n" +
      "--- v1\tv1\n+++ v1\tv2\n@@ -1,1 +1,1 @@\n" +
      "-a line that is not in the keyframe\n+replacement\n";
    const h = (c: string) => `sha256:${c.repeat(64)}`; // schema-valid hash shape
    const history =
      "keyframe_interval: 10\n" +
      "versions:\n" +
      "  - version: 1\n" +
      "    keyframe: true\n" +
      "    edited_by: someone@test.com\n" +
      "    edited_at: '2026-01-01T00:00:00.000Z'\n" +
      `    content_hash: ${h("a")}\n` +
      `    chain_hash: ${h("b")}\n` +
      "  - version: 2\n" +
      `    diff: ${JSON.stringify(badDiff)}\n` +
      "    edited_by: someone@test.com\n" +
      "    edited_at: '2026-01-02T00:00:00.000Z'\n" +
      `    content_hash: ${h("c")}\n` +
      `    chain_hash: ${h("d")}\n`;
    const files: FileEntry[] = [
      mdFile("broken.md", "title: Broken\nstatus: published\nversion: 3", "current body"),
      { path: ".versions/broken/v1.md", content: "---\ntitle: Broken\nversion: 1\nstatus: published\n---\noriginal body\n" },
      { path: ".versions/broken/history.yaml", content: history },
    ];
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      { name: "Broken Chain", files },
      alice.apiKey,
    );
    expect(status).toBe(201);
    expect(data.documents).toBe(1);
    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${data.nest.id}/nodes`,
      undefined,
      alice.apiKey,
    );
    const broken = list.data.nodes.find((n: any) => n.id === "broken");
    // Reset path published it fresh rather than dropping it as draft.
    expect(broken.status).toBe("published");
  });
});
