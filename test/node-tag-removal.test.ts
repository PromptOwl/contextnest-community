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

/**
 * The board's drag-to-retag sends ONLY `tags` — no content, no title. That is a
 * write to a document whose body the user never opened, so the body has to
 * survive it; a patch that treated the missing field as "clear it" would empty
 * a document on a drag.
 */
describe("a tags-only patch assigns the tag without touching the document", () => {
  it("keeps the body and the title, and stores the new tag", async () => {
    await patchTags(["#todo"]);
    const before = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes/${DOC}`, undefined, alice.apiKey);
    const body = (before.data.node ?? before.data).content;
    expect(body).toContain("# doc");

    // Exactly what planMove produces for a drag from #todo to #doing.
    const res = await patchTags(["#doing"]);
    expect(res.status).toBe(200);

    const after = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes/${DOC}`, undefined, alice.apiKey);
    const node = after.data.node ?? after.data;
    expect(node.tags).toEqual(["#doing"]);
    expect(node.content).toBe(body);
    expect(node.title).toBe("Tagged Doc");
  });

  it("a bare tag is stored with the # the board reads back", async () => {
    // The board writes "#doing"; a layout typed without the # must land the same
    // way, or the card would not rejoin the column it was dropped on.
    expect((await patchTags(["doing"])).status).toBe(200);
    expect(await readTags()).toEqual(["#doing"]);
  });
});
