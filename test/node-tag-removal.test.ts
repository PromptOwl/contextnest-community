/**
 * PATCH /nodes tags is REPLACE, not merge. The editor sends the full tag set
 * on every save, so a union made tag removal impossible — a removed tag came
 * back on reopen. MCP `context_update` keeps its "tags to add" contract by
 * merging at its own call site.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

const DOC = "nodes/tagged-doc";

beforeAll(async () => {
  setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Tags" }, alice.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`,
    { title: "Tagged Doc", content: "# doc", tags: ["alpha", "beta"] }, alice.apiKey);
});

const patchTags = (tags: string[]) =>
  jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${DOC}`, { tags }, alice.apiKey);

const readTags = async (): Promise<string[]> => {
  const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${DOC}`, undefined, alice.apiKey);
  expect(res.status).toBe(200);
  return (res.data.node ?? res.data).tags ?? [];
};

describe("tag removal persists", () => {
  it("dropping a tag from the patch removes it", async () => {
    expect(await readTags()).toEqual(expect.arrayContaining(["#alpha", "#beta"]));

    // The editor re-sends the surviving tags exactly as it read them.
    const res = await patchTags(["#alpha"]);
    expect(res.status).toBe(200);

    const tags = await readTags();
    expect(tags).toContain("#alpha");
    expect(tags).not.toContain("#beta");
  });

  it("an empty array clears every tag", async () => {
    expect((await patchTags([])).status).toBe(200);
    expect(await readTags()).toEqual([]);
  });

  it("tags can still be added back", async () => {
    expect((await patchTags(["gamma"])).status).toBe(200);
    expect(await readTags()).toEqual(["#gamma"]);
  });
});
