/**
 * A node under open review is frozen against move/delete — except for the
 * people who can clear the review. An admin who could reject-then-delete in
 * two calls was blocked from doing it in one, which is what left superseded
 * documents piling up as stubs nobody could remove.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";
import { getDb } from "../src/db/client.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; email: string };
let admin: { apiKey: string; email: string };
let editor: { apiKey: string; email: string };
let nestId: string;

/** Create a doc, then submit it for review as its author. */
async function submitForReview(title: string, slug: string) {
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title, content: `# ${title}` },
    owner.apiKey,
  );
  const review = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes/nodes/${slug}/submit-review`,
    {},
    owner.apiKey,
  );
  expect(review.status).toBe(201);
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  admin = await registerUser(app, "admin@acme.com", "Admin");
  editor = await registerUser(app, "editor@acme.com", "Editor");
  await resetAuthRateLimit(); // REGISTER_LIMIT is 3 per IP
  const reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");

  const nest = await jsonRequest(app, "POST", "/nests", { name: "Vault" }, owner.apiKey);
  nestId = nest.data.nest.id;

  for (const [email, permission] of [
    [admin.email, "admin"],
    [editor.email, "write"],
    [reviewer.email, "read"],
  ] as const) {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email, permission },
      owner.apiKey,
    );
    expect(res.status).toBe(201);
  }

  // A steward row is what turns stewardship (and the review lock) on.
  const steward = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/stewards`,
    { scope: "nest", users: [{ email: reviewer.email, role: "reviewer" }] },
    owner.apiKey,
  );
  expect(steward.status).toBe(201);
});

afterAll(() => env.cleanup());

describe("review lock: who can still move or delete", () => {
  it("blocks an editor from deleting a node under review", async () => {
    await submitForReview("Editor Blocked", "editor-blocked");
    const res = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/nodes/nodes/editor-blocked`,
      undefined,
      editor.apiKey,
    );
    expect(res.status).toBe(423);
    expect(String(res.data.error)).toContain("awaiting steward review");
  });

  it("lets an admin delete a node under review", async () => {
    await submitForReview("Admin Deletes", "admin-deletes");
    const res = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/nodes/nodes/admin-deletes`,
      undefined,
      admin.apiKey,
    );
    expect(res.status).toBe(200);

    const gone = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/admin-deletes`,
      undefined,
      owner.apiKey,
    );
    expect(gone.status).toBe(404);
  });

  // A draft in a governed nest is never rewritten by the publish path, so it
  // still carries the frontmatter shape that used to break serialization on
  // move. The row offers Move — it has to actually work.
  it("moves a draft and keeps it a draft", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Still Draft", content: "# Still Draft" },
      owner.apiKey,
    );
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/still-draft/move`,
      { folder: "drafts" },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.node.id).toBe("nodes/drafts/still-draft");

    const moved = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/drafts/still-draft`,
      undefined,
      owner.apiKey,
    );
    expect(moved.status).toBe(200);
    expect(moved.data.node.status).toBe("draft");
  });

  it("lets an admin move a node under review, review state included", async () => {
    await submitForReview("Admin Moves", "admin-moves");
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/admin-moves/move`,
      { folder: "archive" },
      admin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.node.id).toBe("nodes/archive/admin-moves");

    // The pending review followed the node rather than being orphaned.
    const row = (await getDb().get(
      "SELECT node_id FROM review_requests WHERE nest_id = ? AND status = 'pending' AND node_id LIKE ?",
      [nestId, "%admin-moves"],
    )) as { node_id: string } | undefined;
    expect(row?.node_id).toBe("nodes/archive/admin-moves");
  });
});
