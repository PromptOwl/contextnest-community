/**
 * context_overview must respect the same per-caller gate as every other read.
 *
 * It used to call storage.discoverDocuments() and return EVERY node's title,
 * type, tags and a 120-character body excerpt with no access check at all —
 * the hole resolveLlmBody closed for context_get and context_search, still open
 * here. A public reader could list a governed nest's unapproved drafts.
 *
 * Note what is NOT a leak: a read-tier collaborator is *meant* to see every
 * node (canUserAccess allows anyone with view rights). The gate that matters
 * is filterAccessible's public-reader branch, which keeps a stranger to
 * approved content only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { handleToolCall } from "../src/mcp/tools.js";
import { engineCache } from "../src/nodes/engine.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let stranger: { apiKey: string; userId: string; email: string };
let nestId: string;

/** Call the tool the way the MCP transport does, as a given user. */
async function overviewAs(user: { userId: string; email: string }): Promise<string> {
  const { storage, query, versions } = await (engineCache as any).get(nestId);
  return handleToolCall("context_overview", {}, {
    storage,
    queryEngine: query,
    versionManager: versions,
    nestId,
    userId: user.userId,
    userEmail: user.email,
  } as any);
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  // Never a collaborator on the nest — that is what makes them a public reader.
  stranger = await registerUser(app, "stranger@acme.com", "Stranger");

  const nest = await jsonRequest(app, "POST", "/nests", { name: "Gated" }, owner.apiKey);
  nestId = nest.data.nest.id;

  // Created while ungoverned → auto-published and approved, so it is public.
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Open Doc", content: "# anyone may read this" },
    owner.apiKey,
  );

  // Governed from here: this one stays an unapproved draft.
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title: "Secret Roadmap", content: "acquisition plans for Q4" },
    owner.apiKey,
  );

  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/visibility`,
    { visibility: "public", acknowledge_public: true },
    owner.apiKey,
  );
}, 30000);

afterAll(() => env.cleanup());

describe("context_overview access gating", () => {
  it("shows the owner both nodes, and reports nothing withheld", async () => {
    const text = await overviewAs(owner);
    expect(text).toContain("Open Doc");
    expect(text).toContain("Secret Roadmap");
    // The total comes from the engine's whole-vault count while the list comes
    // from the caller-gated one. If those two ever disagree about what counts as
    // a node, a fully-authorized caller would be told documents were hidden.
    expect(text).not.toMatch(/not visible to you/);
  });

  it("does not leak an unapproved draft's title or body to a public reader", async () => {
    const text = await overviewAs(stranger);
    expect(text).toContain("Open Doc");
    expect(text).not.toContain("Secret Roadmap");
    expect(text).not.toContain("acquisition plans");
  });

  it("says how many nodes were withheld rather than under-reporting the vault", async () => {
    const text = await overviewAs(stranger);
    // Silently reporting a smaller vault would read as "there is nothing else".
    expect(text).toMatch(/1 node\(s\) not visible to you/);
  });
});

// A read that gates AFTER the fetch answers a question the caller was not
// entitled to ask: a missing node 404s while an existing-but-restricted one
// 403s, so probing ids reveals which documents a governed nest holds.
describe("reading a node by id does not reveal whether it exists", () => {
  it("returns the same status for a restricted node and a nonexistent one", async () => {
    const existing = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/secret-roadmap`,
      undefined,
      stranger.apiKey,
    );
    const missing = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/no-such-document-at-all`,
      undefined,
      stranger.apiKey,
    );
    expect(existing.status).not.toBe(200);
    expect(existing.status).toBe(missing.status);
  });

  it("still serves the node to someone who may read it", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/secret-roadmap`,
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.node.title).toBe("Secret Roadmap");
  });
});
