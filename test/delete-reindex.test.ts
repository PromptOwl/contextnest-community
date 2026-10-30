/**
 * Deleting a node must drop it from the vault index too.
 *
 * deleteNode removed the .md file and purged the governance rows, but never
 * regenerated context.yaml — so the index kept listing a document that no
 * longer existed, and graph-mode reads (which seed from that index) kept
 * resolving it. The delete now goes through the engine operation, which
 * regenerates.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, settleSeals } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Indexed" }, owner.apiKey);
  nestId = nest.data.nest.id;
}, 30000);

afterAll(() => env.cleanup());

const indexText = async (): Promise<string> => {
  await settleSeals();
  const p = join(env.dataDir, "nests", nestId, "context.yaml");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
};

describe("deleting a node re-indexes the vault", () => {
  it("drops the deleted node from context.yaml", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Doomed Doc", content: "# about to go" },
      owner.apiKey,
    );
    const nodeId = created.data.node.id;
    expect(await indexText()).toContain("doomed-doc");

    const del = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/nodes/${nodeId}`,
      undefined,
      owner.apiKey,
    );
    expect(del.status).toBe(200);

    // The file is gone AND the index no longer advertises it.
    expect(existsSync(join(env.dataDir, "nests", nestId, `${nodeId}.md`))).toBe(false);
    expect(await indexText()).not.toContain("doomed-doc");
  });

  it("leaves the other nodes in the index alone", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Keeper Doc", content: "# stays" },
      owner.apiKey,
    );
    const gone = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Goner Doc", content: "# leaves" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/nodes/${gone.data.node.id}`,
      undefined,
      owner.apiKey,
    );
    const text = await indexText();
    expect(text).toContain("keeper-doc");
    expect(text).not.toContain("goner-doc");
  });
});
