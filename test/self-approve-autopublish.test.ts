/**
 * "Allow self-approve" = owner/admin governance bypass.
 *
 * When a governed nest has allow_self_approve ON, an owner's (or admin's)
 * create/update publishes IMMEDIATELY — no submit-review, no pending queue.
 * Editors/reviewers are unaffected: their edits still land as drafts awaiting
 * review. This locks that role split.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let editor: { apiKey: string; userId: string; email: string };
let nestId: string;

/** Status of a single node as the caller sees it (getDisplayStatus). */
async function statusOf(caller: any, slug: string): Promise<string> {
  const { data } = await jsonRequest(
    app,
    "GET",
    `/nests/${nestId}/nodes`,
    undefined,
    caller.apiKey,
  );
  return data.nodes.find((n: any) => n.id === `nodes/${slug}`)?.status;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  editor = await registerUser(app, "editor@acme.com", "Editor");

  // Governed nest with self-approve ON.
  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Nest" }, owner.apiKey);
  nestId = data.nest.id;
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true, allow_self_approve: true },
    owner.apiKey,
  );

  // Editor steward so the editor can write but not approve.
  const nestPath = join(env.dataDir, "nests", nestId);
  mkdirSync(nestPath, { recursive: true });
  writeFileSync(
    join(nestPath, "stewards.yaml"),
    `version: 1\nnest:\n  - email: ${editor.email}, role: editor\n`,
  );
  await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);
});

afterAll(() => env.cleanup());

it("owner create publishes immediately (no review) under self-approve", async () => {
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "doc-a", content: "# doc-a\n\nbody" },
    owner.apiKey,
  );
  expect(await statusOf(owner, "doc-a")).toBe("published");
});

it("owner update re-publishes immediately, no pending review", async () => {
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/nodes/nodes/doc-a`,
    { content: "# doc-a\n\nedited by owner", changeNote: "tweak" },
    owner.apiKey,
  );
  expect(await statusOf(owner, "doc-a")).toBe("published");
});

it("editor edit still drafts — the bypass is owner/admin only", async () => {
  const { status } = await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/nodes/nodes/doc-a`,
    { content: "# doc-a\n\nedited by editor", changeNote: "editor change" },
    editor.apiKey,
  );
  expect(status).toBe(200);
  // Editor's write lands as a draft awaiting review, NOT published.
  expect(await statusOf(owner, "doc-a")).toBe("draft");
});
