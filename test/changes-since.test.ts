/**
 * GET /nests/:id/changes?since=<ISO> — the sync primitive for external
 * mirrors (GitHub/GitBook): created/updated/deleted since a point in time.
 * Deletions come from node_deletions tombstones, the one record the DELETE
 * purge leaves behind.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;
let t0: string;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Mirror" }, alice.apiKey);
  nestId = nest.data.nest.id;

  // Pre-t0 baseline doc.
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Old Doc", content: "# Old" },
    alice.apiKey,
  );
  await wait(20);
  t0 = new Date().toISOString();
  await wait(20);

  // Post-t0 activity: update the old doc, create a new one, create + delete one.
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/nodes/nodes/old-doc`,
    { append: "\nMore." },
    alice.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "New Doc", content: "# New content here" },
    alice.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Doomed Doc", content: "# Doomed" },
    alice.apiKey,
  );
  await jsonRequest(
    app,
    "DELETE",
    `/nests/${nestId}/nodes/nodes/doomed-doc`,
    undefined,
    alice.apiKey,
  );
});

afterAll(() => env.cleanup());

describe("GET /nests/:id/changes", () => {
  it("rejects a missing or malformed since", async () => {
    const missing = await jsonRequest(app, "GET", `/nests/${nestId}/changes`, undefined, alice.apiKey);
    expect(missing.status).toBe(400);
    const bad = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/changes?since=yesterday-ish`,
      undefined,
      alice.apiKey,
    );
    expect(bad.status).toBe(400);
  });

  it("buckets created, updated, and deleted since the given time", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/changes?since=${encodeURIComponent(t0)}`,
      undefined,
      alice.apiKey,
    );
    expect(res.status).toBe(200);

    const createdIds = res.data.created.map((n: any) => n.id);
    expect(createdIds).toContain("nodes/new-doc");
    // Deleted docs never appear as created, even though they were made post-t0.
    expect(createdIds).not.toContain("nodes/doomed-doc");

    const updatedIds = res.data.updated.map((n: any) => n.id);
    expect(updatedIds).toContain("nodes/old-doc");

    expect(res.data.deleted.map((d: any) => d.id)).toContain("nodes/doomed-doc");
    expect(res.data.deleted[0].deleted_by).toBe(alice.email);
    // Content is omitted unless asked for.
    expect(res.data.created[0].content).toBeUndefined();
  });

  it("a since after all activity returns empty buckets", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/changes?since=${encodeURIComponent(future)}`,
      undefined,
      alice.apiKey,
    );
    expect(res.data.created).toEqual([]);
    expect(res.data.updated).toEqual([]);
    expect(res.data.deleted).toEqual([]);
  });

  it("read-tier callers get deleted: null (no tombstone leak), not an empty list", async () => {
    const reader = await registerUser(app, "reader@acme.com", "Reader");
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: reader.email, permission: "read" },
      alice.apiKey,
    );
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/changes?since=${encodeURIComponent(t0)}`,
      undefined,
      reader.apiKey,
    );
    expect(res.status).toBe(200);
    // Tombstones bypass per-node read gates, so they're write+ only. null
    // (not []) so a mirror can't mistake "not allowed" for "no deletions".
    expect(res.data.deleted).toBeNull();
    // created/updated stay caller-gated as before.
    expect(res.data.created.map((n: any) => n.id)).toContain("nodes/new-doc");
  });

  it("include_content=1 ships the bodies", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/changes?since=${encodeURIComponent(t0)}&include_content=1`,
      undefined,
      alice.apiKey,
    );
    const doc = res.data.created.find((n: any) => n.id === "nodes/new-doc");
    expect(doc.content).toContain("New content here");
  });

  it("delete then recreate lands in created[], not deleted[]", async () => {
    const since = new Date().toISOString();
    await wait(20);
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Reborn Doc", content: "# First life" },
      alice.apiKey,
    );
    await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/nodes/nodes/reborn-doc`,
      undefined,
      alice.apiKey,
    );
    // Same title → same id. The tombstone is upserted on delete, then the id is
    // live again on recreate, so /changes must surface it as created, not deleted.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Reborn Doc", content: "# Second life" },
      alice.apiKey,
    );
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/changes?since=${encodeURIComponent(since)}`,
      undefined,
      alice.apiKey,
    );
    expect(res.data.created.map((n: any) => n.id)).toContain("nodes/reborn-doc");
    expect(res.data.deleted.map((d: any) => d.id)).not.toContain("nodes/reborn-doc");
  });
});

// Governed public nest: for a PUBLIC reader the change signal is the approval
// time, not the raw frontmatter updated_at (which bumps on unapproved drafts the
// public body never reflects). Guards the false-positive that mirrors the
// approved-after-since false-negative already fixed on the main path.
describe("GET /changes — public-reader approval signal", () => {
  let gNest: string;
  let sPub: string;
  let bob: { apiKey: string; userId: string; email: string };

  beforeAll(async () => {
    bob = await registerUser(app, "bob@acme.com", "Bob");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Public Mirror" }, alice.apiKey);
    gNest = nest.data.nest.id;
    // allow_self_approve now means owner/admin writes publish immediately, so
    // the owner can seed an approved public body directly. An UNAPPROVED draft
    // can therefore only come from an editor — bob is added below for that.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${gNest}/settings`,
      { stewardship_enabled: true, allow_self_approve: true },
      alice.apiKey,
    );
    // bob: editor steward — can draft, never auto-publishes.
    const nestPath = join(env.dataDir, "nests", gNest);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `version: 1\nnest:\n  - email: ${bob.email}, role: editor\n`,
    );
    await jsonRequest(app, "POST", `/nests/${gNest}/stewards/sync`, {}, alice.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${gNest}/visibility`, { visibility: "public" }, alice.apiKey);

    // Owner create auto-publishes under self-approve → public reader has an
    // approved body to see.
    await jsonRequest(
      app,
      "POST",
      `/nests/${gNest}/nodes`,
      { title: "Spec", content: "# APPROVED BODY" },
      alice.apiKey,
    );

    await wait(20);
    sPub = new Date().toISOString();
    await wait(20);

    // Unapproved draft edit AFTER sPub by the EDITOR: bumps frontmatter
    // updated_at, but the approved (public-visible) body is unchanged.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${gNest}/nodes/nodes/spec`,
      { append: "\nDRAFT ONLY" },
      bob.apiKey,
    );
  });

  it("an unapproved draft edit does NOT appear in updated[] for a public reader", async () => {
    // Anonymous = public reader (no Authorization).
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${gNest}/changes?since=${encodeURIComponent(sPub)}&include_content=1`,
    );
    expect(res.status).toBe(200);
    expect(res.data.updated.map((n: any) => n.id)).not.toContain("nodes/spec");
    expect(res.data.created.map((n: any) => n.id)).not.toContain("nodes/spec");
  });

  it("the owner (who sees drafts) still gets the draft edit in updated[]", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${gNest}/changes?since=${encodeURIComponent(sPub)}`,
      undefined,
      alice.apiKey,
    );
    expect(res.data.updated.map((n: any) => n.id)).toContain("nodes/spec");
  });

  it("an approval after `since` surfaces for a public reader (approved_at signal)", async () => {
    // approved_at is second-precision (SQLite datetime), so let the clock cross
    // into a later second than sPub before approving — otherwise the truncated
    // approved_at can floor below sPub's sub-second and the signal reads stale.
    await wait(1100);
    // Approve the pending draft edit → new approved_at > sPub.
    await jsonRequest(app, "POST", `/nests/${gNest}/nodes/nodes/spec/submit-review`, { note: "r" }, alice.apiKey);
    await jsonRequest(app, "POST", `/nests/${gNest}/nodes/nodes/spec/approve`, { note: "publish" }, alice.apiKey);
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${gNest}/changes?since=${encodeURIComponent(sPub)}&include_content=1`,
    );
    const doc = res.data.updated.find((n: any) => n.id === "nodes/spec");
    expect(doc).toBeDefined();
    // Now approved, so the public reader sees the newly-published body.
    expect(doc.content).toContain("DRAFT ONLY");
  });
});
