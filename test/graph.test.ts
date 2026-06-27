import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
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

    // Steward overlay
    const steward = data.stewards.find(
      (s: any) => s.scope === "tag" && s.target === "market-x",
    );
    expect(steward).toBeDefined();
    expect(steward.email).toBe("jane@acme.com");
    expect(steward.role).toBe("reviewer");
  });
});
