/**
 * POST /nests/:nestId/publish — batch semantics.
 *
 * The batch is not a transaction: documents are created one at a time and the
 * ones written before a failure stay written. That is only defensible if the
 * response says which rows landed, so the contract under test is:
 *  - a row the create path rejects goes to `failed` and the batch CONTINUES;
 *  - a row whose id is taken goes to `skipped`, never overwritten;
 *  - re-running the same batch converges instead of duplicating.
 *
 * The one error that stops the batch early is the vault write lock timing out
 * (503 + Retry-After) — covered in vault-busy.test.ts, where the lock can be
 * simulated.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

const OWNER_EMAIL = "owner@example.com";

beforeEach(() => setupTestEnv());

async function makeNest(app: any, apiKey: string): Promise<string> {
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Bulk" }, apiKey);
  expect(nest.status).toBe(201);
  return nest.data.nest.id;
}

describe("bulk publish — partial-batch reporting", () => {
  it("reports a rejected row in `failed` and still publishes the rest", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const nestId = await makeNest(app, admin.apiKey);

    // Middle row is over the 120-char title bound. Before per-row reporting it
    // threw, leaving "First" written and nothing in the response naming it.
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      {
        documents: [
          { title: "First", content: "# one" },
          { title: "T".repeat(200), content: "# too long" },
          { title: "Third", content: "# three" },
        ],
      },
      admin.apiKey,
    );

    expect(res.status).toBe(201);
    expect(res.data.published).toBe(2);
    expect(res.data.node_ids).toEqual(["nodes/first", "nodes/third"]);
    expect(res.data.failed).toHaveLength(1);
    expect(res.data.failed[0].title).toBe("T".repeat(200));
    expect(res.data.failed[0].error).toMatch(/120 characters/);

    // The row AFTER the failure is the one that used to be abandoned.
    const third = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/third`,
      undefined,
      admin.apiKey,
    );
    expect(third.status).toBe(200);
  });

  it("re-running a batch skips what exists instead of duplicating or overwriting", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const nestId = await makeNest(app, admin.apiKey);

    const batch = { documents: [{ title: "Alpha", content: "# original" }] };

    const first = await jsonRequest(app, "POST", `/nests/${nestId}/publish`, batch, admin.apiKey);
    expect(first.status).toBe(201);
    expect(first.data.published).toBe(1);
    expect(first.data.skipped).toEqual([]);

    // Same batch again — this is what a caller does after a 503. It must not
    // republish and must not overwrite the body already on disk.
    const retry = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      { documents: [{ title: "Alpha", content: "# REPLACED" }] },
      admin.apiKey,
    );
    expect(retry.status).toBe(201);
    expect(retry.data.published).toBe(0);
    expect(retry.data.skipped).toEqual(["Alpha"]);
    expect(retry.data.failed).toEqual([]);

    const doc = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/alpha`,
      undefined,
      admin.apiKey,
    );
    expect(doc.status).toBe(200);
    expect(doc.data.node.content).toContain("original");
    expect(doc.data.node.content).not.toContain("REPLACED");
  });

  it("keeps a pushed document's folder instead of filing it flat at the nest root", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const nestId = await makeNest(app, admin.apiKey);

    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/publish`,
      {
        documents: [
          { title: "Nested Doc", content: "# nested", folder: "subteam" },
        ],
      },
      admin.apiKey,
    );

    expect(res.status).toBe(201);
    expect(res.data.published).toBe(1);
    expect(res.data.node_ids).toEqual(["nodes/subteam/nested-doc"]);
  });
});
