import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";
import { extractWikiTargets } from "../src/nodes/graph-service.js";
import { createStewardRecord } from "../src/governance/stewardship-service.js";

describe("graph: wikilink extraction", () => {
  it("extracts [[targets]] and ignores |display aliases", () => {
    expect(extractWikiTargets("see [[Beta]] and [[Gamma|the third]] here")).toEqual([
      "Beta",
      "Gamma",
    ]);
    expect(extractWikiTargets("no links at all")).toEqual([]);
  });
});

describe("graph: ontology endpoint", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    owner = await registerUser(app, "owner@acme.com", "Owner");

    const nest = await jsonRequest(app, "POST", "/nests", { name: "Ontology" }, owner.apiKey);
    nestId = nest.data.nest.id;

    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Alpha", content: "Intro. See [[Beta]] for more.", tags: ["market-x"] },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Beta", content: "Body. Links to [[Gamma]].", tags: ["market-x"] },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Gamma", content: "No outbound links.", tags: ["market-y"] },
      owner.apiKey,
    );

    // Tag-scoped steward (assigned directly via the service — the HTTP roster
    // is server-admin only).
    await createStewardRecord({
      nestId,
      scope: "tag",
      tagName: "market-x",
      users: [{ email: "jane@acme.com", role: "reviewer" }],
      assignedBy: "owner@acme.com",
    });
  });

  afterAll(() => env.cleanup());

  it("assembles nodes, resolved wikilink edges, tag counts and the steward overlay", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/graph`,
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(200);

    // Nodes
    expect(data.nodes).toHaveLength(3);

    // Resolved edges: alpha→beta, beta→gamma
    const edgeKeys = data.links.map((l: any) => `${l.source}->${l.target}`);
    expect(data.links).toHaveLength(2);
    expect(edgeKeys).toContain("nodes/alpha->nodes/beta");
    expect(edgeKeys).toContain("nodes/beta->nodes/gamma");

    // Tag counts (market-x carried by two nodes)
    const marketX = data.tags.find((t: any) => t.name === "market-x");
    expect(marketX?.count).toBe(2);

    // Steward overlay — owner is admin-tier, so identities are visible.
    const steward = data.stewards.find(
      (s: any) => s.scope === "tag" && s.target === "market-x",
    );
    expect(steward).toBeDefined();
    expect(steward.label).toBe("jane@acme.com");
    expect(steward.id).toBe("jane@acme.com");
    expect(steward.role).toBe("reviewer");

    // Steward edges are pre-assembled server-side.
    const stewardEdge = data.stewardEdges.find(
      (e: any) => e.steward === "jane@acme.com" && e.scope === "tag",
    );
    expect(stewardEdge?.target).toBe("tag:market-x");

    // Full set, no truncation.
    expect(data.truncated).toBe(false);
    expect(data.totalNodes).toBe(3);

    // Governance signals (server-computed over the full set).
    // market-y has no tag steward → flagged; market-x does → not.
    const gapTags = data.signals.unstewardedTags.map((t: any) => t.name);
    expect(gapTags).toContain("market-y");
    expect(gapTags).not.toContain("market-x");
    // jane owns market-x (alpha + beta) = 2/3 docs → bottleneck at 67%.
    const jane = data.signals.bottlenecks.find((b: any) => b.label === "jane@acme.com");
    expect(jane?.share).toBe(67);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Steward-identity masking (CU-wdqcpzujc4 security fix)
//
// Steward emails are write+ only — same rule as the collaborators roster — so a
// public/read tier can't enumerate member emails via the graph overlay.
// ═══════════════════════════════════════════════════════════════════════════

describe("graph: steward identity masking for sub-write callers", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let viewer: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["owner@acme.com"] });
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    viewer = await registerUser(app, "viewer@acme.com", "Viewer");

    const nest = await jsonRequest(app, "POST", "/nests", { name: "Masked" }, owner.apiKey);
    nestId = nest.data.nest.id;

    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Alpha", content: "See [[Beta]].", tags: ["market-x"] },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Beta", content: "Body.", tags: ["market-x"] },
      owner.apiKey,
    );

    await createStewardRecord({
      nestId,
      scope: "tag",
      tagName: "market-x",
      users: [{ email: "jane@acme.com", role: "reviewer" }],
      assignedBy: "owner@acme.com",
    });

    // viewer joins as a read-only collaborator.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "viewer@acme.com", permission: "read" },
      owner.apiKey,
    );
  }, 30000);

  afterAll(() => env.cleanup());

  it("masks steward emails to an opaque token for a read-tier caller", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/graph`,
      undefined,
      viewer.apiKey,
    );
    expect(status).toBe(200);

    const steward = data.stewards.find((s: any) => s.scope === "tag");
    expect(steward).toBeDefined();
    expect(steward.id).toBe("s1");
    expect(steward.label).toBe("Steward 1");

    // The email must not leak anywhere in the payload.
    expect(JSON.stringify(data)).not.toContain("jane@acme.com");
    // Bottleneck still surfaces — by masked label, not email.
    const bottleneck = data.signals.bottlenecks[0];
    expect(bottleneck?.label).toBe("Steward 1");
    expect(bottleneck?.steward).toBe("s1");
  });

  it("shows real emails to the owner (write+)", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/graph`,
      undefined,
      owner.apiKey,
    );
    const steward = data.stewards.find((s: any) => s.scope === "tag");
    expect(steward.label).toBe("jane@acme.com");
  });
});
