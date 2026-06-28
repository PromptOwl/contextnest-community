import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// Collaboration comments (CU-wdqcpzudt3)
//
// Comments are a DB-only collaboration primitive — separate from the
// versioned/hash-chained node. They carry attribution, thread, and resolve,
// and they feed a per-node activity log ("who did what"). Creating or
// resolving a comment must NOT mutate the node's version chain.
// ═══════════════════════════════════════════════════════════════════════════

describe("comments: standalone, threaded, attributed, resolvable", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string; email: string };
  let reader: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let nodeId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["owner@acme.com"] });
    owner = await registerUser(app, "owner@acme.com", "Owner");
    reader = await registerUser(app, "reader@acme.com", "Reader");

    const { data: nestData } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Collab Vault" },
      owner.apiKey,
    );
    nestId = nestData.nest.id;

    // reader is a read-only collaborator — must still be able to comment.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "reader@acme.com", permission: "read" },
      owner.apiKey,
    );

    const { data: nodeData } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Spec Doc", content: "# Spec\n\nfirst draft" },
      owner.apiKey,
    );
    nodeId = nodeData.node.id;
  }, 30000);

  afterAll(() => env.cleanup());

  const nodePath = (suffix = "") =>
    `/nests/${nestId}/nodes/${nodeId}/comments${suffix}`;

  it("creates a comment with attribution, anchored to a highlight span", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      nodePath(),
      {
        body: "This sentence needs a citation.",
        anchor: { start: 8, end: 19, text: "first draft" },
        version: 1,
      },
      owner.apiKey,
    );
    expect(status).toBe(201);
    expect(data.comment.id).toBeTruthy();
    expect(data.comment.author).toBe("owner@acme.com");
    expect(data.comment.status).toBe("open");
    expect(data.comment.body).toBe("This sentence needs a citation.");
    expect(data.comment.anchor).toEqual({ start: 8, end: 19, text: "first draft" });
    expect(data.comment.createdAt).toBeTruthy();
  });

  it("rejects an empty comment body", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      nodePath(),
      { body: "   " },
      owner.apiKey,
    );
    expect(status).toBe(400);
  });

  it("lets a read-only collaborator comment", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      nodePath(),
      { body: "Agreed — I'll find the source." },
      reader.apiKey,
    );
    expect(status).toBe(201);
    expect(data.comment.author).toBe("reader@acme.com");
  });

  it("threads a reply under a parent comment", async () => {
    const { data: parent } = await jsonRequest(
      app,
      "POST",
      nodePath(),
      { body: "Top-level thread." },
      owner.apiKey,
    );
    const { status, data } = await jsonRequest(
      app,
      "POST",
      nodePath(),
      { body: "A reply.", parentId: parent.comment.id },
      reader.apiKey,
    );
    expect(status).toBe(201);
    expect(data.comment.parentId).toBe(parent.comment.id);
  });

  it("lists comments for the node", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      nodePath(),
      undefined,
      reader.apiKey,
    );
    expect(status).toBe(200);
    expect(Array.isArray(data.comments)).toBe(true);
    expect(data.comments.length).toBeGreaterThanOrEqual(4);
    // attribution + timestamps on every row
    for (const cmt of data.comments) {
      expect(cmt.author).toBeTruthy();
      expect(cmt.createdAt).toBeTruthy();
    }
  });

  it("resolves a comment and records who resolved it", async () => {
    const { data: created } = await jsonRequest(
      app,
      "POST",
      nodePath(),
      { body: "Resolve me." },
      reader.apiKey,
    );
    const { status, data } = await jsonRequest(
      app,
      "POST",
      nodePath(`/${created.comment.id}/resolve`),
      {},
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.comment.status).toBe("resolved");
    expect(data.comment.resolvedBy).toBe("owner@acme.com");
    expect(data.comment.resolvedAt).toBeTruthy();

    // open-only filter excludes it
    const { data: openOnly } = await jsonRequest(
      app,
      "GET",
      nodePath("?status=open"),
      undefined,
      owner.apiKey,
    );
    expect(
      openOnly.comments.find((x: any) => x.id === created.comment.id),
    ).toBeUndefined();
  });

  it("commenting does NOT bump the node version chain", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/versions`,
      undefined,
      owner.apiKey,
    );
    // Node was created once; comments must not have created new versions.
    expect(data.currentVersion).toBe(1);
  });

  it("activity feed aggregates who did what (comments + edits)", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/activity`,
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(Array.isArray(data.activity)).toBe(true);
    const types = new Set(data.activity.map((a: any) => a.type));
    expect(types.has("comment")).toBe(true);
    expect(types.has("edit")).toBe(true); // node creation = an edit event
    expect(types.has("comment_resolved")).toBe(true);
    // every entry attributes an actor + timestamp
    for (const ev of data.activity) {
      expect(ev.actor).toBeTruthy();
      expect(ev.at).toBeTruthy();
    }
    // reader and owner both show up as actors
    const actors = new Set(data.activity.map((a: any) => a.actor));
    expect(actors.has("owner@acme.com")).toBe(true);
    expect(actors.has("reader@acme.com")).toBe(true);
  });

  it("activity feed surfaces a pending external edit as 'edit_proposed'", async () => {
    // Pending external-edit suggestions live on disk (not SQLite). Stage one
    // by hand-editing the node's on-disk file out-of-band, then running the
    // drift scan — this is exactly "Bob proposed an edit" from the ticket.
    const nestDir = join(process.env.DATA_ROOT!, "nests", nestId);
    // The node's document body lives under nodes/<slug>.md inside the nest.
    const docFile = (readdirSync(nestDir, { recursive: true } as any) as string[])
      .map((f) => String(f))
      .find((f) => f.endsWith(".md") && f.includes("nodes"));
    expect(docFile).toBeTruthy();
    const docPath = join(nestDir, docFile!);
    writeFileSync(
      docPath,
      readFileSync(docPath, "utf-8") + "\n\nAn out-of-band hand edit.\n",
    );

    const { data: scan } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/external-edits/scan`,
      {},
      owner.apiKey,
    );
    expect(scan.staged).toBeGreaterThanOrEqual(1);

    // Per-node feed now carries the proposal, attributed + timestamped.
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/activity`,
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(200);
    const proposed = data.activity.filter(
      (a: any) => a.type === "edit_proposed",
    );
    expect(proposed.length).toBeGreaterThanOrEqual(1);
    expect(proposed[0].actor).toBeTruthy();
    expect(proposed[0].at).toBeTruthy();
    expect(proposed[0].nodeId).toBe(nodeId);

    // And the nest-wide feed surfaces it too.
    const { data: nestFeed } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/activity`,
      undefined,
      owner.apiKey,
    );
    expect(
      nestFeed.activity.some((a: any) => a.type === "edit_proposed"),
    ).toBe(true);
  });
});
