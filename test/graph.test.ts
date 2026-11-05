import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";
import { extractContextTargets, extractWikiTargets } from "../src/nodes/graph-service.js";
import { createStewardRecord } from "../src/governance/stewardship-service.js";
import { setStewardshipEnabled } from "../src/nests/service.js";

describe("graph: wikilink extraction", () => {
  it("extracts [[targets]] and ignores |display aliases", () => {
    expect(extractWikiTargets("see [[Beta]] and [[Gamma|the third]] here")).toEqual([
      "Beta",
      "Gamma",
    ]);
    expect(extractWikiTargets("no links at all")).toEqual([]);
  });
});

describe("graph: contextnest:// link extraction", () => {
  it("strips pin, anchor and trailing slash; handles autolinks; de-duplicates", () => {
    expect(
      extractContextTargets(
        [
          "[pinned](contextnest://nodes/foo@3#bar)",
          "[anchored](contextnest://nodes/baz#setup) <contextnest://nodes/qux@12>",
          "[again](contextnest://nodes/foo) [folder](contextnest://nodes/dir/)",
        ].join("\n"),
      ),
    ).toEqual(["nodes/foo", "nodes/baz", "nodes/qux", "nodes/dir"]);
  });

  it("ignores links inside inline code and fenced code", () => {
    expect(
      extractContextTargets(
        "`[x](contextnest://nodes/inline)`\n```\n[y](contextnest://nodes/fenced)\n```\n",
      ),
    ).toEqual([]);
    expect(extractContextTargets("")).toEqual([]);
  });

  it("stays linear on an adversarial run of brackets", () => {
    const evil = "[".repeat(50_000) + "](contextnest://nodes/x";
    const t0 = Date.now();
    // Only the final `[](…` is a real link; the 50k unclosed `[` must not
    // each rescan the line.
    expect(extractContextTargets(evil)).toEqual(["nodes/x"]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("graph: contextnest:// links are ontology edges", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    owner = await registerUser(app, "uri-owner@acme.com", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "URI Graph" }, owner.apiKey);
    nestId = nest.data.nest.id;
    const add = (title: string, content: string) =>
      jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content }, owner.apiKey);
    await add("Target A", "a");
    await add("Target B", "b");
    // `gone` is a stray bare-slug collision bait: a dangling nodes/x/gone URI
    // must NOT attach to it via slug resolution.
    await add("Gone", "bait");
    await add(
      "Source",
      "[[Target A]] and [b](contextnest://nodes/target-b@1#top) and [x](contextnest://nodes/elsewhere/gone)\n```\n[c](contextnest://nodes/gone)\n```",
    );
  });

  afterAll(() => env.cleanup());

  it("draws the URI edge like the wikilink edge; dangling and code-fenced URIs draw nothing", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/graph`,
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(200);
    const edgeKeys = data.links.map((l: any) => `${l.source}->${l.target}`).sort();
    expect(edgeKeys).toEqual(["nodes/source->nodes/target-a", "nodes/source->nodes/target-b"]);
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
// Slug-form wikilink resolution
//
// The editor inserts links as `[[<bare-slug>|Title]]` (slugFromNodeId), and
// some as the full `[[nodes/<slug>|Title]]` path — NOT the title. The graph
// must resolve those the way the client does (id, title, OR bare slug), or a
// real link renders no edge and its source looks like a false orphan.
// ═══════════════════════════════════════════════════════════════════════════

describe("graph: slug-form wikilink resolution", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Slugs" }, owner.apiKey);
    nestId = nest.data.nest.id;

    // Alpha links to Beta by bare slug and to Gamma by full path — both with a
    // |display alias, exactly as the editor writes them.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Alpha", content: "See [[beta|Beta]] and [[nodes/gamma|Gamma]].", tags: [] },
      owner.apiKey,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Beta", content: "Body." }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Gamma", content: "Body." }, owner.apiKey);
  });

  afterAll(() => env.cleanup());

  it("resolves bare-slug and full-path link forms to edges", async () => {
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/graph`, undefined, owner.apiKey);
    const edgeKeys = data.links.map((l: any) => `${l.source}->${l.target}`);
    expect(edgeKeys).toContain("nodes/alpha->nodes/beta");
    expect(edgeKeys).toContain("nodes/alpha->nodes/gamma");
    // Alpha has outbound edges → not a false orphan.
    const orphanIds = data.signals.orphans.map((n: any) => n.id);
    expect(orphanIds).not.toContain("nodes/alpha");
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

// ═══════════════════════════════════════════════════════════════════════════
// Steward gating + node dedup (review follow-ups)
// ═══════════════════════════════════════════════════════════════════════════

describe("graph: steward gating and node dedup", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    owner = await registerUser(app, "owner@acme.com", "Owner");

    const nest = await jsonRequest(app, "POST", "/nests", { name: "Gated" }, owner.apiKey);
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

    // Same person holds BOTH a tag-scope and a document-scope row.
    await createStewardRecord({
      nestId,
      scope: "tag",
      tagName: "market-x",
      users: [{ email: "jane@acme.com", role: "reviewer" }],
      assignedBy: "owner@acme.com",
    });
    await createStewardRecord({
      nestId,
      scope: "document",
      documentId: "nodes/alpha",
      users: [{ email: "jane@acme.com", role: "editor" }],
      assignedBy: "owner@acme.com",
    });
  });

  afterAll(() => env.cleanup());

  it("emits one steward NODE per identity but one EDGE per row", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/graph`,
      undefined,
      owner.apiKey,
    );
    // Two rows for jane → one node, two edges.
    expect(data.stewards.filter((s: any) => s.id === "jane@acme.com")).toHaveLength(1);
    expect(data.stewardEdges.filter((e: any) => e.steward === "jane@acme.com")).toHaveLength(2);
  });

  it("returns no stewards once stewardship is disabled", async () => {
    setStewardshipEnabled(nestId, false);
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/graph`,
      undefined,
      owner.apiKey,
    );
    expect(data.stewards).toHaveLength(0);
    expect(data.stewardEdges).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tag-based edges (CU-wdqcq02g16)
//
// A shared tag is a relationship, same as a [[wikilink]] — two docs with no
// wikilink between them but a common tag should still produce a graph edge
// and neither should read as an orphan.
// ═══════════════════════════════════════════════════════════════════════════

describe("graph: tag-based edges", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "TagEdges" }, owner.apiKey);
    nestId = nest.data.nest.id;

    // Delta and Epsilon share a tag but carry no [[wikilink]] to each other.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Delta", content: "No wikilinks here.", tags: ["market-z"] },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Epsilon", content: "No wikilinks here either.", tags: ["market-z"] },
      owner.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("connects docs that share a tag, even with no [[wikilink]] between them", async () => {
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/graph`, undefined, owner.apiKey);
    const edgeKeys = data.links.map((l: any) => `${l.source}->${l.target}`);
    expect(edgeKeys).toContain("nodes/delta->nodes/epsilon");

    // Tag-connected docs are not orphans.
    const orphanIds = data.signals.orphans.map((n: any) => n.id);
    expect(orphanIds).not.toContain("nodes/delta");
    expect(orphanIds).not.toContain("nodes/epsilon");
  });
});

describe("graph: sub-item parent edges", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "SubItems" }, owner.apiKey);
    nestId = nest.data.nest.id;
    const add = (body: Record<string, unknown>) =>
      jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, owner.apiKey);
    // No wikilinks or shared tags: the parent field is the only relation.
    await add({ title: "Launch", type: "task", content: "x", tags: ["a"] });
    const child = await add({ title: "Write copy", type: "task", content: "y", tags: ["b"], parent: "nodes/launch" });
    expect(child.status).toBe(201);
  });

  afterAll(() => env.cleanup());

  it("links a sub-item to its parent so neither is an orphan", async () => {
    const { data } = await jsonRequest(app, "GET", `/nests/${nestId}/graph`, undefined, owner.apiKey);
    const edgeKeys = data.links.map((l: any) => `${l.source}->${l.target}`);
    expect(edgeKeys).toContain("nodes/write-copy->nodes/launch");
    const orphanIds = data.signals.orphans.map((n: any) => n.id);
    expect(orphanIds).not.toContain("nodes/launch");
    expect(orphanIds).not.toContain("nodes/write-copy");
  });
});
