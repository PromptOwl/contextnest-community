/**
 * Listing batch-resolvers: the whole-nest replacements for the per-node
 * governance lookups a 400-document listing used to pay one at a time.
 * Each test asserts the batched answer equals the per-node one it replaced.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

describe("listing batch resolvers", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: Awaited<ReturnType<typeof registerUser>>;
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    // Owner doubles as super admin so the steward roster endpoints are reachable.
    app = await createTestApp("key", { superAdmins: ["owner@batch.test"] });
    owner = await registerUser(app, "owner@batch.test");
    const { data } = await jsonRequest(
      app, "POST", "/nests", { name: "Batch Nest" }, owner.apiKey,
    );
    nestId = data.nest.id;

    for (const [title, tags] of [
      ["Alpha Doc", ["arch"]],
      ["Beta Doc", ["arch", "gtm"]],
      ["Gamma Doc", []],
    ] as [string, string[]][]) {
      await jsonRequest(
        app, "POST", `/nests/${nestId}/nodes`,
        { title, content: `# ${title}\n\nBody.`, tags },
        owner.apiKey,
      );
    }
    // One document in a nested folder, so the id-shape logic sees a real path.
    await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes`,
      { title: "Deal Doc", content: "# Deal Doc\n\nBody.", folder: "gtm/deals" },
      owner.apiKey,
    );
    // Put one node into a different workflow state than the rest.
    await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes/nodes/alpha-doc/submit-review`,
      { note: "please review" }, owner.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("getDisplayStatuses matches getDisplayStatus for every node", async () => {
    const versions = await import("../src/governance/version-service.js");
    const { data } = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes`, undefined, owner.apiKey,
    );
    const ids: string[] = data.nodes.map((n: any) => n.id);
    expect(ids.length).toBe(4);

    const batched = await versions.getDisplayStatuses(nestId);
    for (const id of ids) {
      expect(batched.get(id) ?? "draft").toBe(
        await versions.getDisplayStatus(nestId, id),
      );
    }
    // The submitted one must actually differ, or the parity above is vacuous.
    expect(batched.get("nodes/alpha-doc")).toBe("pending_review");
  });

  it("documentsWithSuggestions finds staged edits and ignores the archive", async () => {
    const { documentsWithSuggestions } = await import(
      "../src/governance/external-edit-service.js"
    );
    expect((await documentsWithSuggestions(nestId)).size).toBe(0);

    // Engine layout: {docDir}/_suggestions/{docName}/{id}.meta.yaml — resolved
    // suggestions move under _archive and must not read as staged.
    const root = join(env.dataDir, "nests", nestId);
    const staged = join(root, "nodes", "gtm", "deals", "_suggestions", "deal-doc");
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "s1.meta.yaml"), "suggestion_id: s1\n");
    const archived = join(root, "nodes", "_suggestions", "gamma-doc", "_archive", "approved");
    mkdirSync(archived, { recursive: true });
    writeFileSync(join(archived, "s2.meta.yaml"), "suggestion_id: s2\n");

    expect([...(await documentsWithSuggestions(nestId))]).toEqual([
      "nodes/gtm/deals/deal-doc",
    ]);
  });

  it("stewardCoverageForUser resolves document, tag and nest scope in one pass", async () => {
    const { stewardCoverageForUser } = await import(
      "../src/governance/stewardship-service.js"
    );
    const mate = "mate@batch.test";
    const assign = async (payload: Record<string, unknown>) => {
      const { status } = await jsonRequest(
        app, "POST", `/nests/${nestId}/stewards`, payload, owner.apiKey,
      );
      expect(status).toBe(201);
    };

    await assign({
      scope: "document", email: mate, role: "viewer",
      nodePattern: "nodes/gamma-doc",
    });
    expect(await stewardCoverageForUser(nestId, mate)).toEqual({
      nestWide: false,
      nodeIds: new Set(["nodes/gamma-doc"]),
    });

    // A tag row covers every node carrying that tag, via node_tag_index.
    await assign({ scope: "tag", email: mate, role: "viewer", tagName: "arch" });
    const tagged = await stewardCoverageForUser(nestId, mate);
    expect(tagged.nestWide).toBe(false);
    expect([...tagged.nodeIds].sort()).toEqual([
      "nodes/alpha-doc",
      "nodes/beta-doc",
      "nodes/gamma-doc",
    ]);

    // A nest row outranks the rest — everything is covered.
    await assign({ scope: "nest", email: mate, role: "viewer" });
    expect((await stewardCoverageForUser(nestId, mate)).nestWide).toBe(true);
  });
});
