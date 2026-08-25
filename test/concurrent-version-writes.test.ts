/**
 * Concurrent saves must not corrupt version history.
 *
 * Regression for the autosave race: overlapping PATCHes each read the same
 * base version and appended "base+1", producing duplicate/swapped version
 * numbers that broke the engine diff chain (history showed "(no content)")
 * and split the DB count from history.yaml. updateNode now serializes writes
 * per node, so a burst of concurrent edits yields a clean, contiguous,
 * reconstructable history — and numbering keeps going afterward.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let nodeId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");
  const created = await jsonRequest(app, "POST", "/nests", {
    name: "Concurrency Nest",
  });
  nestId = created.data.nest.id;
  const node = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Race Doc",
    content: "# base\n\nbody",
    tags: ["x"],
  });
  nodeId = node.data.node.id;
});

afterAll(() => env.cleanup());

describe("concurrent version writes", () => {
  it("serializes a burst of edits into a contiguous, reconstructable history", async () => {
    const N = 15;
    // Fire N edits at once, without awaiting between them — the exact
    // overlap that used to duplicate/skip version numbers.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${nodeId}`, {
          content: `# base\n\nedit ${i}`,
        }),
      ),
    );
    for (const r of results) expect(r.status).toBe(200);

    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/versions`,
    );
    const nums = data.versions
      .map((v: any) => v.version)
      .sort((a: number, b: number) => a - b);

    // No duplicate version numbers.
    expect(new Set(nums).size).toBe(nums.length);
    // No gaps — strictly contiguous.
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBe(nums[i - 1] + 1);
    }
    // Latest version reconstructs to real content, not "(no content)". The list
    // ships change logs, so the body comes from the per-version endpoint.
    const latest = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/versions/${data.currentVersion}`,
    );
    expect(latest.data.content).toContain("edit");
    // Each non-first version carries its own stored change log.
    const withDiff = data.versions.filter((v: any) => v.diff);
    expect(withDiff.length).toBeGreaterThan(0);
    expect(withDiff[0].diff).toContain("@@");
  });

  it("keeps numbering after the burst (next save = max + 1, stored)", async () => {
    const before = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/versions`,
    );
    const maxBefore = before.data.currentVersion;

    const patch = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "# base\n\nfinal" },
    );
    expect(patch.status).toBe(200);

    const after = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/versions`,
    );
    expect(after.data.currentVersion).toBe(maxBefore + 1);
    const top = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/versions/${after.data.currentVersion}`,
    );
    expect(top.data.content).toContain("final");
  });
});
