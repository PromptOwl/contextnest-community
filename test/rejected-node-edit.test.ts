import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

/**
 * Editing a document whose stored status is `rejected`.
 *
 * The engine refuses an update that would leave a document rejected — otherwise
 * a client echoing the current status back would rewrite the body of a document
 * that stays out of retrieval. The editor sends content, tags and title on save
 * but no status, so that guard saw `status: undefined` and every save of a
 * rejected document failed with an opaque 500. Community lists rejected
 * documents on purpose (`include_retired: true`), so they are openable and
 * editable — an imported vault carrying `status: rejected` in its frontmatter
 * hits this on its first edit.
 */

let env: ReturnType<typeof setupTestEnv>;
beforeEach(() => {
  env = setupTestEnv();
});

/** Rewrite a node's markdown on disk with a `rejected` status, the way an
 *  imported vault would arrive. */
function markRejectedOnDisk(dataDir: string, nestId: string, nodeId: string) {
  const path = join(dataDir, "nests", nestId, `${nodeId}.md`);
  const raw = readFileSync(path, "utf-8");
  const patched = raw.replace(/^status:.*$/m, "status: rejected");
  // The document must actually end up rejected, or the test proves nothing.
  expect(patched).toMatch(/^status: rejected$/m);
  writeFileSync(path, patched, "utf-8");
  return path;
}

describe("editing a rejected document", () => {
  it("revives it to a draft instead of failing the save", async () => {
    const app = await createTestApp("key");
    const user = await registerUser(app, "reviver@example.com");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Rev" }, user.apiKey);
    const nestId = nest.data.nest.id;

    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Rejected Doc", content: "# Rejected Doc\n\noriginal" },
      user.apiKey,
    );
    const nodeId = created.data.node.id;
    markRejectedOnDisk(env.dataDir, nestId, nodeId);

    // A plain save — content only, no status — which is what the editor sends.
    const saved = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "# Rejected Doc\n\nedited" },
      user.apiKey,
    );

    expect(saved.status).toBe(200);
    expect(saved.data.node.status).not.toBe("rejected");

    const after = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}`,
      undefined,
      user.apiKey,
    );
    expect(after.data.node.content).toContain("edited");
    expect(after.data.node.status).not.toBe("rejected");
  });

  it("still refuses when the caller re-asserts rejected, and says why", async () => {
    const app = await createTestApp("key");
    const user = await registerUser(app, "reasserter@example.com");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Rev2" }, user.apiKey);
    const nestId = nest.data.nest.id;

    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Stays Rejected", content: "# Stays Rejected\n\nbody" },
      user.apiKey,
    );
    const nodeId = created.data.node.id;
    markRejectedOnDisk(env.dataDir, nestId, nodeId);

    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "# Stays Rejected\n\nedited", status: "rejected" },
      user.apiKey,
    );

    // A conflict the caller can act on — not the generic 500 this used to be.
    expect(res.status).toBe(409);
    expect(String(res.data.error)).toMatch(/rejected/i);
  });
});
