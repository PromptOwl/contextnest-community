/**
 * A new version must never reuse a number already in the engine's chain.
 *
 * `history.yaml` is append-only. The steward draft-save path numbered the next
 * version off the SQLite `node_versions` rows, so whenever the DB lagged the
 * on-disk chain — a nest imported with its `.versions/` copied along, or an
 * engine append whose DB mirror failed (see external-edit-service, which
 * explicitly tolerates a skipped `node_versions` row) — the next save reused a
 * live number and grafted a SECOND chain onto the first. Symptoms: duplicate
 * entries in history.yaml, `v{N}.md` keyframes overwritten at the same number,
 * and reconstruction dying with "Failed to apply diff for version N" from the
 * graft point on, which shows as "(no content)" in the version panel and an
 * empty body for approved-only reads.
 *
 * The draft path now numbers through the engine's `nextVersion()`, which
 * outranks the recorded history as well as the caller's hint.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string };
let editor: { apiKey: string; userId: string };
let nestId: string;
const nodeId = "nodes/chain-doc";

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["lead@acme.com"] });
  owner = await registerUser(app, "lead@acme.com", "Lead");
  editor = await registerUser(app, "dev@acme.com", "Dev");

  const created = await jsonRequest(
    app,
    "POST",
    "/nests",
    { name: "Graft Nest" },
    owner.apiKey,
  );
  nestId = created.data.nest.id;

  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: "dev@acme.com", permission: "write" },
    owner.apiKey,
  );

  // Stewardship on, and dev is a plain editor — so dev's edits take the
  // draft-version path rather than owner auto-publish.
  const nestPath = join(env.dataDir, "nests", nestId);
  mkdirSync(nestPath, { recursive: true });
  writeFileSync(
    join(nestPath, "stewards.yaml"),
    `nest:
  - email: dev@acme.com, role: editor, can_approve: false
  - email: lead@acme.com, role: reviewer, can_approve: true
`,
  );
  await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);

  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Chain Doc", content: "# base\n\nv1 body" },
    owner.apiKey,
  );
  // A couple of editor drafts so the chain has diffs, not just a keyframe.
  for (const n of [2, 3]) {
    const r = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: `# base\n\nv${n} body` },
      editor.apiKey,
    );
    expect(r.status).toBe(200);
  }
});

afterAll(() => env.cleanup());

/** Highest version the engine's own history.yaml holds for the node. */
async function chainHead(): Promise<number> {
  const { engineCache } = await import("../src/nodes/engine.js");
  const { storage } = await engineCache.get(nestId);
  const history = await storage.readHistory(nodeId);
  return (history?.versions ?? []).reduce((max, e) => Math.max(max, e.version), 0);
}

/** Drop the top N version rows so SQLite lags the on-disk engine chain. */
async function dropTopVersionRows(count: number): Promise<void> {
  const { getDb } = await import("../src/db/client.js");
  await getDb().run(
    `DELETE FROM node_versions WHERE nest_id = ? AND node_id = ? AND version IN (
       SELECT version FROM node_versions WHERE nest_id = ? AND node_id = ?
       ORDER BY version DESC LIMIT ?
     )`,
    [nestId, nodeId, nestId, nodeId, count],
  );
}

describe("per-version change logs", () => {
  it("stores a v{N}.diff change log per version, no full-body duplication", async () => {
    const { readdirSync } = await import("fs");
    const dir = join(
      env.dataDir,
      "nests",
      nestId,
      "nodes",
      ".versions",
      "chain-doc",
    );
    const files = readdirSync(dir);

    // v1 is the keyframe (full snapshot); everything after it is a change log.
    expect(files).toContain("v1.md");
    expect(files).toContain("v2.diff");
    expect(files).toContain("v3.diff");
    expect(files).not.toContain("v2.md");
    expect(files).not.toContain("v3.md");

    // history.yaml holds metadata only — no patch bytes inline.
    const { engineCache } = await import("../src/nodes/engine.js");
    const { storage } = await engineCache.get(nestId);
    for (const entry of (await storage.readHistory(nodeId))!.versions) {
      expect(entry.diff).toBeUndefined();
    }
  });

  it("serves the change log in the list and the body only on demand", async () => {
    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/versions`,
      undefined,
      owner.apiKey,
    );
    const v2 = list.data.versions.find((v: any) => v.version === 2);
    // A real unified diff — hunk headers included, so DiffViewer renders it
    // with line numbers exactly like a commit.
    expect(v2.diff).toContain("@@");
    // The list does NOT ship full bodies; that is the duplication being avoided.
    for (const v of list.data.versions) expect(v.content).toBeFalsy();

    const body = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/versions/2`,
      undefined,
      owner.apiKey,
    );
    expect(body.status).toBe(200);
    expect(body.data.content).toContain("v2 body");
  });

  it("enriches rows with the steward who resolved the review", async () => {
    // Editor submits, reviewer approves — the resolver's email lives only in
    // review_requests, so the list endpoint has to join it in.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "# base\n\nfor review" },
      editor.apiKey,
    );
    const submit = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/submit-review`,
      {},
      editor.apiKey,
    );
    expect(submit.status).toBe(201);
    const approve = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/approve`,
      {},
      owner.apiKey,
    );
    expect(approve.status).toBe(200);

    const list = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/versions`,
      undefined,
      owner.apiKey,
    );
    const resolved = list.data.versions.filter((v: any) => v.resolvedBy);
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[0].resolvedBy).toBe("lead@acme.com");
    expect(resolved[0].resolutionStatus).toBe("approved");
  });
});

describe("draft version numbering vs the engine chain", () => {
  it("does not reuse a chain version number when the DB lags history.yaml", async () => {
    const head = await chainHead();
    expect(head).toBeGreaterThanOrEqual(3);

    await dropTopVersionRows(2);
    const lagged = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/versions`,
      undefined,
      owner.apiKey,
    );
    expect(lagged.data.currentVersion).toBeLessThan(head);

    const patch = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "# base\n\nafter lag" },
      editor.apiKey,
    );
    expect(patch.status).toBe(200);

    // Numbered past the chain head, not past the stale DB row.
    expect(await chainHead()).toBe(head + 1);

    // history.yaml holds no duplicate version numbers.
    const { engineCache } = await import("../src/nodes/engine.js");
    const { storage } = await engineCache.get(nestId);
    const nums = (await storage.readHistory(nodeId))!.versions.map((e) => e.version);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it("keeps the whole chain reconstructable after the lagged save", async () => {
    const { engineCache } = await import("../src/nodes/engine.js");
    const { storage, versions } = await engineCache.get(nestId);
    const history = (await storage.readHistory(nodeId))!;

    for (const entry of history.versions) {
      await expect(
        versions.reconstructVersion(nodeId, entry.version),
        `v${entry.version} did not reconstruct`,
      ).resolves.toContain("---");
    }
  });
});
