/**
 * Discarding a draft.
 *
 * Unreviewed work is the live file plus one governance row — it is never
 * appended to the engine's hash chain, which is append-only and so could never
 * give a draft back. That is what makes discard cheap: the last sealed version
 * is still in the chain, so putting the file back is a plain write, and the
 * rows above the seal are just deleted.
 *
 * Two shapes, and the difference matters: a document that was published once
 * falls back to that version; a document that never was has nothing to fall
 * back to, so discarding its draft deletes it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string };
let editor: { apiKey: string; userId: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["lead@acme.com"] });
  owner = await registerUser(app, "lead@acme.com", "Lead");
  editor = await registerUser(app, "dev@acme.com", "Dev");

  const created = await jsonRequest(app, "POST", "/nests", { name: "Discard Nest" }, owner.apiKey);
  nestId = created.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: "dev@acme.com", permission: "write" },
    owner.apiKey,
  );

  // Stewardship on: dev drafts, lead reviews. Without it every save
  // auto-publishes and there is no draft to discard.
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
});

afterAll(() => env.cleanup());

/** Versions the engine's chain holds for a node — sealed ones only. */
async function chainVersions(nodeId: string): Promise<number[]> {
  const { engineCache } = await import("../src/nodes/engine.js");
  const { storage } = await engineCache.get(nestId);
  return ((await storage.readHistory(nodeId))?.versions ?? []).map((e) => e.version);
}

async function draftRowCount(nodeId: string): Promise<number> {
  const { getDb } = await import("../src/db/client.js");
  const row = (await getDb().get(
    `SELECT COUNT(*) as c FROM node_versions
      WHERE nest_id = ? AND node_id = ? AND status IN ('draft', 'rejected')`,
    [nestId, nodeId],
  )) as { c: number };
  return Number(row.c);
}

async function createDoc(title: string, content: string): Promise<string> {
  const r = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title, content },
    editor.apiKey,
  );
  expect(r.status).toBe(201);
  return r.data.node.id;
}

describe("draft saves stay out of the version chain", () => {
  it("appends nothing until the draft is submitted", async () => {
    const nodeId = await createDoc("Chainless Doc", "# d\n\nfirst");
    expect(await chainVersions(nodeId)).toEqual([]);

    for (const body of ["second", "third", "fourth"]) {
      const r = await jsonRequest(
        app,
        "PATCH",
        `/nests/${nestId}/nodes/${nodeId}`,
        { content: `# d\n\n${body}` },
        editor.apiKey,
      );
      expect(r.status).toBe(200);
    }
    // Three saves, still no chain — and only ONE draft row, because a
    // superseded draft describes bytes nothing can reconstruct.
    expect(await chainVersions(nodeId)).toEqual([]);
    expect(await draftRowCount(nodeId)).toBe(1);

    const submit = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/submit-review`,
      {},
      editor.apiKey,
    );
    expect(submit.status).toBe(201);
    expect(await chainVersions(nodeId)).toHaveLength(1);
  });
});

describe("discarding a draft on a published document", () => {
  it("puts the file back to the approved version and drops the draft", async () => {
    const nodeId = await createDoc("Published Doc", "# p\n\napproved body");
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/submit-review`,
      {},
      editor.apiKey,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/approve`, {}, owner.apiKey);

    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "# p\n\nunreviewed rewrite" },
      editor.apiKey,
    );
    const dirty = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}`,
      undefined,
      editor.apiKey,
    );
    expect(dirty.data.node.content).toContain("unreviewed rewrite");
    expect(await draftRowCount(nodeId)).toBe(1);

    const sealedBefore = await chainVersions(nodeId);
    const discard = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/discard`,
      {},
      editor.apiKey,
    );
    expect(discard.status).toBe(200);
    expect(discard.data.deleted).toBe(false);

    const restored = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}`,
      undefined,
      editor.apiKey,
    );
    expect(restored.data.node.content).toContain("approved body");
    expect(restored.data.node.content).not.toContain("unreviewed rewrite");
    expect(await draftRowCount(nodeId)).toBe(0);
    // The point of keeping drafts out of the chain: discarding costs no
    // version, so history is exactly what it was.
    expect(await chainVersions(nodeId)).toEqual(sealedBefore);
  });

  it("takes the draft off the author's My Drafts list", async () => {
    const before = await jsonRequest(app, "GET", "/me/drafts", undefined, editor.apiKey);
    const ids = before.data.drafts.map((d: any) => d.node_id);
    expect(ids).not.toContain("nodes/published-doc");
  });
});

describe("discarding a draft that was never published", () => {
  it("deletes the document — there is nothing to fall back to", async () => {
    const nodeId = await createDoc("Never Published", "# n\n\nonly ever a draft");
    const filePath = join(env.dataDir, "nests", nestId, "nodes", "never-published.md");
    expect(existsSync(filePath)).toBe(true);

    const discard = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/discard`,
      {},
      editor.apiKey,
    );
    expect(discard.status).toBe(200);
    expect(discard.data.deleted).toBe(true);
    expect(existsSync(filePath)).toBe(false);

    const gone = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}`,
      undefined,
      editor.apiKey,
    );
    expect(gone.status).toBe(404);
  });
});

describe("discard and the review lock", () => {
  it("refuses (423) while the document is awaiting review", async () => {
    const nodeId = await createDoc("Locked Doc", "# l\n\nsubmitted");
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/submit-review`,
      {},
      editor.apiKey,
    );
    // The author is not exempt here the way they are for editing: discarding
    // would pull the document out from under the reviewer.
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/discard`,
      {},
      editor.apiKey,
    );
    expect(status).toBe(423);
  });
});

describe("My Drafts search and sort", () => {
  it("filters by title and sorts by it", async () => {
    await createDoc("Zebra Notes", "# z\n\nz");
    await createDoc("Apple Notes", "# a\n\na");

    const found = await jsonRequest(
      app,
      "GET",
      "/me/drafts?q=zebra",
      undefined,
      editor.apiKey,
    );
    expect(found.status).toBe(200);
    expect(found.data.drafts.map((d: any) => d.title)).toEqual(["Zebra Notes"]);
    // Exact once filtered — the in-memory path counts what survives.
    expect(found.data.pagination.total).toBe(1);

    const sorted = await jsonRequest(
      app,
      "GET",
      "/me/drafts?q=notes&sort=title",
      undefined,
      editor.apiKey,
    );
    expect(sorted.data.drafts.map((d: any) => d.title)).toEqual([
      "Apple Notes",
      "Zebra Notes",
    ]);
  });
});

describe("discarding after several draft saves", () => {
  it("serves the approved body on the next read, not the last draft", async () => {
    const nodeId = await createDoc("Multi Save Doc", "# m\n\napproved body");
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/submit-review`, {}, editor.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/approve`, {}, owner.apiKey);

    for (const n of [1, 2, 3]) {
      const r = await jsonRequest(
        app,
        "PATCH",
        `/nests/${nestId}/nodes/${nodeId}`,
        { content: `# m\n\ndraft edit ${n}` },
        editor.apiKey,
      );
      expect(r.status).toBe(200);
    }

    const discard = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/discard`, {}, editor.apiKey);
    expect(discard.status).toBe(200);
    expect(discard.data.deleted).toBe(false);

    const after = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${nodeId}`, undefined, editor.apiKey);
    expect(after.data.node.content).toContain("approved body");
    expect(after.data.node.content).not.toContain("draft edit 3");
  });
});

/**
 * The subtle path: a rejected draft that is edited again while its review was
 * repointed, then resubmitted and approved.
 *
 * Under the no-seal-until-submit rule the repointed version is unsealed, so
 * each submission is what puts a version in the chain — and a resubmission with
 * no edit in between must not append the same number twice.
 */
describe("reject → re-edit → re-submit → approve", () => {
  it("seals each submitted version once and approves the edited content", async () => {
    const nodeId = await createDoc("Bounced Doc", "# b\n\nfirst try");
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/submit-review`, {}, editor.apiKey);
    const sealedAtFirstSubmit = await chainVersions(nodeId);
    expect(sealedAtFirstSubmit).toHaveLength(1);

    const reject = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/reject`,
      { note: "needs work" },
      owner.apiKey,
    );
    expect(reject.status).toBe(200);

    // Resubmitting with NO edit must not append the same version again.
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/submit-review`, {}, editor.apiKey);
    expect(await chainVersions(nodeId)).toEqual(sealedAtFirstSubmit);

    // Author revises their own pending submission — repointPendingReview moves
    // the open review onto the new draft, which is NOT sealed yet.
    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "# b\n\nsecond try" },
      editor.apiKey,
    );
    expect(edit.status).toBe(200);
    expect(await chainVersions(nodeId)).toEqual(sealedAtFirstSubmit);

    const approve = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${nodeId}/approve`, {}, owner.apiKey);
    expect(approve.status).toBe(200);

    // The edited content is what got approved, and the chain grew — no
    // duplicate version numbers anywhere in it.
    const after = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${nodeId}`, undefined, editor.apiKey);
    expect(after.data.node.content).toContain("second try");
    const sealed = await chainVersions(nodeId);
    expect(sealed.length).toBeGreaterThan(sealedAtFirstSubmit.length);
    expect(new Set(sealed).size).toBe(sealed.length);
  });
});
