import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";
import {
  clampAnchor,
  projectThreadsToMarkdown,
  MAX_CONTEXT_CHARS,
  MAX_QUOTE_CHARS,
} from "../src/annotations/projection.js";
import type { AnnotationThread } from "../src/annotations/types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Pure projection (no app / no DB)
// ═══════════════════════════════════════════════════════════════════════════

describe("annotations: anchor + markdown projection", () => {
  it("clampAnchor returns null when there is no quote", () => {
    expect(clampAnchor(null)).toBeNull();
    expect(clampAnchor({ quote: "   " })).toBeNull();
  });

  it("clampAnchor caps context windows and keeps a valid line", () => {
    const before = "x".repeat(500);
    const after = "y".repeat(500);
    const a = clampAnchor({ quote: "  hi  ", before, after, line: 42 });
    expect(a).not.toBeNull();
    expect(a!.quote).toBe("hi");
    expect(a!.before.length).toBe(MAX_CONTEXT_CHARS);
    expect(a!.after.length).toBe(MAX_CONTEXT_CHARS);
    expect(a!.line).toBe(42);
  });

  it("clampAnchor drops a non-positive/invalid line", () => {
    expect(clampAnchor({ quote: "hi", before: "", after: "", line: 0 })!.line).toBeUndefined();
    expect(clampAnchor({ quote: "hi", before: "", after: "", line: -3 })!.line).toBeUndefined();
  });

  it("projects open threads before resolved, with hidden anchors", () => {
    const threads: AnnotationThread[] = [
      {
        id: "t-resolved",
        nestId: "n",
        nodeId: "nodes/deck",
        snapshotVersion: 1,
        anchor: { quote: "47 logos", before: "grew ", after: " net" },
        status: "resolved",
        createdBy: "a@x.com",
        createdAt: "2026-06-26 14:20:00",
        resolvedBy: "a@x.com",
        resolvedAt: "2026-06-26 14:55:00",
        comments: [
          { id: "c1", author: "a@x.com", body: "net or gross?", createdAt: "2026-06-26 14:20:00" },
        ],
      },
      {
        id: "t-open",
        nestId: "n",
        nodeId: "nodes/deck",
        snapshotVersion: 1,
        anchor: { quote: "MRR of $400K", before: "reflects ", after: " across", line: 42 },
        status: "open",
        createdBy: "b@x.com",
        createdAt: "2026-06-26 14:02:00",
        resolvedBy: null,
        resolvedAt: null,
        comments: [
          { id: "c2", author: "b@x.com", body: "Should be ARR not MRR.", createdAt: "2026-06-26 14:02:00" },
        ],
      },
    ];

    const md = projectThreadsToMarkdown("Q3 Deck", threads);
    expect(md).toContain("# Q3 Deck — Annotations");
    // Open sorts first
    expect(md.indexOf("🟠 OPEN")).toBeLessThan(md.indexOf("✅ RESOLVED"));
    // Hidden, machine-readable anchor carries quote + context
    expect(md).toContain('quote "MRR of $400K"');
    expect(md).toContain("〈MRR of $400K〉");
    expect(md).toContain("line 42");
    // Comment bodies present for the agent to read
    expect(md).toContain("Should be ARR not MRR.");
    expect(md).toContain("✅ RESOLVED (a@x.com, 2026-06-26 14:55:00)");
  });

  it("renders an empty state when there are no threads", () => {
    expect(projectThreadsToMarkdown("Empty", [])).toContain("_No annotations yet._");
  });

  it("clampAnchor caps the quote length", () => {
    const huge = "z".repeat(MAX_QUOTE_CHARS + 5000);
    const a = clampAnchor({ quote: huge, before: "", after: "" });
    expect(a!.quote.length).toBe(MAX_QUOTE_CHARS);
  });

  it("neutralizes --> so a quote can't break out of the anchor comment", () => {
    const md = projectThreadsToMarkdown("Deck", [
      {
        id: "t1",
        nestId: "n",
        nodeId: "nodes/deck",
        snapshotVersion: 1,
        anchor: { quote: "evil --> out", before: "", after: "" },
        status: "open",
        createdBy: "a@x.com",
        createdAt: "2026-06-26 14:00:00",
        resolvedBy: null,
        resolvedAt: null,
        comments: [{ id: "c1", author: "a@x.com", body: "hi", createdAt: "2026-06-26 14:00:00" }],
      },
    ]);
    // The raw comment-closing sequence must not survive inside the anchor line.
    const anchorLine = md.split("\n").find((l) => l.includes("<!-- anchor:"))!;
    expect(anchorLine).not.toContain("--></");
    expect(anchorLine).not.toContain("evil --> out");
    expect(anchorLine).toContain("evil -→ out");
  });

  it("groups threads by snapshot, newest snapshot first", () => {
    const mk = (
      id: string,
      v: number | null,
      status: "open" | "resolved",
    ): AnnotationThread => ({
      id,
      nestId: "n",
      nodeId: "nodes/deck",
      snapshotVersion: v,
      anchor: null,
      status,
      createdBy: "a@x.com",
      createdAt: "2026-06-26 14:00:00",
      resolvedBy: null,
      resolvedAt: null,
      comments: [{ id: `c-${id}`, author: "a@x.com", body: `body-${id}`, createdAt: "2026-06-26 14:00:00" }],
    });
    const md = projectThreadsToMarkdown("Deck", [
      mk("old", 1, "resolved"),
      mk("new", 2, "open"),
    ]);
    expect(md).toContain("## Snapshot v2");
    expect(md).toContain("## Snapshot v1");
    // Newest snapshot heading precedes the older one.
    expect(md.indexOf("## Snapshot v2")).toBeLessThan(md.indexOf("## Snapshot v1"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// API integration
// ═══════════════════════════════════════════════════════════════════════════

describe("annotations: hosted artifact + threaded comments", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let nodeId: string;

  const HTML = "<!doctype html><html><body><h1>Slide 3</h1><p>MRR of $400K</p></body></html>";

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    alice = await registerUser(app, "alice@acme.com", "Alice");

    const nest = await jsonRequest(app, "POST", "/nests", { name: "Decks" }, alice.apiKey);
    nestId = nest.data.nest.id;

    const node = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Q3 Deck", content: HTML, type: "artifact" },
      alice.apiKey,
    );
    nodeId = node.data.node.id; // "nodes/q3-deck"
  });

  afterAll(() => env.cleanup());

  it("serves the artifact HTML with a sandbox CSP", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/${nodeId}/hosted`, {
      headers: { Authorization: `Bearer ${alice.apiKey}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("text/html");
    expect(res.headers.get("content-security-policy") || "").toContain("sandbox");
    const text = await res.text();
    expect(text).toContain("Slide 3");
  });

  it("creates an anchored thread, threads replies, resolves and reopens", async () => {
    // Create thread
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/annotations`,
      {
        body: "Should be ARR not MRR.",
        anchor: { quote: "MRR of $400K", before: "reflects ", after: " across", line: 42 },
      },
      alice.apiKey,
    );
    expect(created.status).toBe(201);
    const threadId = created.data.thread.id;
    expect(created.data.thread.status).toBe("open");
    expect(created.data.thread.anchor.quote).toBe("MRR of $400K");
    expect(created.data.thread.comments).toHaveLength(1);

    // Reply
    const replied = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/annotations/${threadId}/comments`,
      { body: "Agreed, regenerate with ARR." },
      alice.apiKey,
    );
    expect(replied.status).toBe(200);
    expect(replied.data.thread.comments).toHaveLength(2);

    // Resolve
    const resolved = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/annotations/${threadId}/resolve`,
      {},
      alice.apiKey,
    );
    expect(resolved.data.thread.status).toBe("resolved");
    expect(resolved.data.thread.resolvedBy).toBe("alice@acme.com");

    // Reopen
    const reopened = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/annotations/${threadId}/reopen`,
      {},
      alice.apiKey,
    );
    expect(reopened.data.thread.status).toBe("open");
    expect(reopened.data.thread.resolvedBy).toBeNull();

    // List
    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/annotations`,
      undefined,
      alice.apiKey,
    );
    expect(list.data.threads).toHaveLength(1);
  });

  it("projects threads into a derived node the nest can pull", async () => {
    const nodes = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes`,
      undefined,
      alice.apiKey,
    );
    const derived = nodes.data.nodes.find(
      (n: any) => n.title === "Q3 Deck — Annotations",
    );
    expect(derived).toBeDefined();
    // The feedback + anchor are readable as ordinary node content (so MCP /
    // context assembly pulls them into the next iteration for free).
    expect(derived.content).toContain("Should be ARR not MRR.");
    expect(derived.content).toContain('quote "MRR of $400K"');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Frozen snapshot + hardening (artifact kind, strict CSP, read-tier perms)
// ═══════════════════════════════════════════════════════════════════════════

describe("annotations: frozen snapshot + hardening", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let artifactId: string;

  const V1 = "<!doctype html><html><body><h1>Slide 3</h1><p>MRR of $400K</p></body></html>";
  const V2 = "<!doctype html><html><body><h1>Slide 3</h1><p>ARR of $4.8M</p></body></html>";

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    alice = await registerUser(app, "alice@acme.com", "Alice");

    const nest = await jsonRequest(app, "POST", "/nests", { name: "Decks" }, alice.apiKey);
    nestId = nest.data.nest.id;

    const node = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Pitch", content: V1, type: "artifact" },
      alice.apiKey,
    );
    artifactId = node.data.node.id;
  });

  afterAll(() => env.cleanup());

  it("serves a strict CSP that blocks exfiltration", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/${artifactId}/hosted`, {
      headers: { Authorization: `Bearer ${alice.apiKey}` },
    });
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).toContain("sandbox");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
  });

  it("404s /hosted for a non-artifact (markdown) node", async () => {
    const doc = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Just A Doc", content: "# hello", type: "document" },
      alice.apiKey,
    );
    const docId = doc.data.node.id;
    const res = await app.request(`/nests/${nestId}/nodes/${docId}/hosted`, {
      headers: { Authorization: `Bearer ${alice.apiKey}` },
    });
    expect(res.status).toBe(404);
  });

  it("freezes snapshots: ?v= serves the old HTML after a re-gen", async () => {
    // Capture the first published snapshot version.
    const before = await app.request(`/nests/${nestId}/nodes/${artifactId}/hosted`, {
      headers: { Authorization: `Bearer ${alice.apiKey}` },
    });
    const v1 = Number(before.headers.get("X-Artifact-Snapshot"));
    expect(v1).toBeGreaterThan(0);
    expect(await before.text()).toContain("MRR of $400K");

    // Re-generate the artifact (new version → new snapshot).
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${artifactId}`,
      { content: V2 },
      alice.apiKey,
    );

    // Default /hosted now serves the new approved snapshot…
    const latest = await app.request(`/nests/${nestId}/nodes/${artifactId}/hosted`, {
      headers: { Authorization: `Bearer ${alice.apiKey}` },
    });
    const latestHtml = await latest.text();
    expect(latestHtml).toContain("ARR of $4.8M");
    expect(latestHtml).not.toContain("MRR of $400K");

    // …but the pinned old snapshot still serves the frozen HTML annotations
    // were anchored against.
    const frozen = await app.request(
      `/nests/${nestId}/nodes/${artifactId}/hosted?v=${v1}`,
      { headers: { Authorization: `Bearer ${alice.apiKey}` } },
    );
    expect(await frozen.text()).toContain("MRR of $400K");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Read-tier permission: a read-only collaborator can annotate
// ═══════════════════════════════════════════════════════════════════════════

describe("annotations: read-only collaborator can annotate", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string; email: string };
  let bob: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let artifactId: string;

  const HTML = "<!doctype html><html><body><p>hello</p></body></html>";

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "owner@acme.com", "Alice");
    bob = await registerUser(app, "reader@acme.com", "Bob");

    const nest = await jsonRequest(app, "POST", "/nests", { name: "Shared" }, alice.apiKey);
    nestId = nest.data.nest.id;

    const node = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Board", content: HTML, type: "artifact" },
      alice.apiKey,
    );
    artifactId = node.data.node.id;

    // Bob gets read-only access.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: bob.email, permission: "read" },
      alice.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("lets a read-only collaborator create + resolve a thread", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${artifactId}/annotations`,
      { body: "Typo in the header." },
      bob.apiKey,
    );
    expect(created.status).toBe(201);
    const threadId = created.data.thread.id;

    const resolved = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${artifactId}/annotations/${threadId}/resolve`,
      {},
      bob.apiKey,
    );
    expect(resolved.status).toBe(200);
    expect(resolved.data.thread.status).toBe("resolved");
  });

  it("still blocks a read-only collaborator from editing the node", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${artifactId}`,
      { content: "<p>hacked</p>" },
      bob.apiKey,
    );
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// IDOR: a thread can only be mutated through its own nest/node URL
// ═══════════════════════════════════════════════════════════════════════════

describe("annotations: thread scope is enforced (no cross-node hijack)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let artA: string;
  let artB: string;
  let threadInB: string;

  const HTML = "<!doctype html><html><body><p>x</p></body></html>";

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    alice = await registerUser(app, "alice@acme.com", "Alice");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Decks" }, alice.apiKey);
    nestId = nest.data.nest.id;

    const a = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`,
      { title: "Deck A", content: HTML, type: "artifact" }, alice.apiKey);
    artA = a.data.node.id;
    const b = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`,
      { title: "Deck B", content: HTML, type: "artifact" }, alice.apiKey);
    artB = b.data.node.id;

    const t = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${artB}/annotations`,
      { body: "thread on B" }, alice.apiKey);
    threadInB = t.data.thread.id;
  });

  afterAll(() => env.cleanup());

  it("404s when commenting on B's thread via A's URL", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${artA}/annotations/${threadInB}/comments`,
      { body: "hijack" },
      alice.apiKey,
    );
    expect(res.status).toBe(404);
  });

  it("404s when resolving B's thread via A's URL", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${artA}/annotations/${threadInB}/resolve`,
      {},
      alice.apiKey,
    );
    expect(res.status).toBe(404);
    // And B's thread is untouched.
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${artB}/annotations`, undefined, alice.apiKey);
    expect(list.data.threads[0].status).toBe("open");
  });
});

describe("annotations: per-nest comment counts (document-list sorting)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string; userId: string; email: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    alice = await registerUser(app, "alice@acme.com", "Alice");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Sortable" }, alice.apiKey);
    nestId = nest.data.nest.id;

    // Two docs: "Popular" gets 2 comment threads, "Quiet" gets none.
    const popular = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Popular", content: "# Popular\n\nlots to say" }, alice.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Quiet", content: "# Quiet" }, alice.apiKey);

    for (const body of ["first note", "second note"]) {
      await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${popular.data.node.id}/annotations`, { body }, alice.apiKey);
    }
  });

  afterAll(() => env.cleanup());

  it("returns per-node comment counts for the nest", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/comment-counts`, undefined, alice.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.counts["nodes/popular"].count).toBe(2);
    expect(res.data.counts["nodes/popular"].lastAt).toBeTruthy();
    // A node with no comments simply isn't in the map.
    expect(res.data.counts["nodes/quiet"]).toBeUndefined();
  });
});
