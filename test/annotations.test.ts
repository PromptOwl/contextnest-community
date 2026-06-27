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
