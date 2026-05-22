import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// Stewardship & Approval Workflow
// ═══════════════════════════════════════════════════════════════════════════

describe("governance: stewardship with stewards.yaml", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let admin: { apiKey: string; userId: string };
  let dev: { apiKey: string; userId: string };
  let reviewer: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    admin = await registerUser(app, "lead@acme.com", "Lead");
    dev = await registerUser(app, "dev@acme.com", "Dev");
    reviewer = await registerUser(app, "jane@acme.com", "Jane");

    // Create nest
    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Governed Vault" },
      admin.apiKey,
    );
    nestId = data.nest.id;

    // Write stewards.yaml into the nest directory
    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `version: 1
nest:
  - email: lead@acme.com, role: admin, can_approve: true
tags:
  #architecture:
    - email: jane@acme.com, role: reviewer, can_approve: true
`,
    );

    // Grant dev and reviewer write access
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "dev@acme.com", permission: "write" },
      admin.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "jane@acme.com", permission: "write" },
      admin.apiKey,
    );

    // Sync stewards
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards/sync`,
      {},
      admin.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("stewards.yaml file exists in the right place", async () => {
    const expectedPath = join(env.dataDir, "nests", nestId, "stewards.yaml");
    expect(existsSync(expectedPath)).toBe(true);
    expect(process.env.DATA_ROOT).toBe(env.dataDir);

    // Also check the loadStewardsConfig function directly
    const { loadStewardsConfig } = await import("../src/governance/stewards-parser.js");
    const config = loadStewardsConfig(nestId);
    expect(config).not.toBeNull();
    expect(config!.nest!.length).toBeGreaterThan(0);
  });

  it("syncs stewards from stewards.yaml", async () => {
    // Re-sync to be sure
    const syncRes = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards/sync`,
      {},
      admin.apiKey,
    );
    // Check sync result
    expect(syncRes.data.synced).toBeGreaterThan(0);

    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/stewards`,
      undefined,
      admin.apiKey,
    );
    expect(status).toBe(200);
    expect(data.stewards.length).toBe(2);
    expect(data.stewards.map((s: any) => s.userEmail).sort()).toEqual([
      "jane@acme.com",
      "lead@acme.com",
    ]);
  });

  it("node created with stewards starts as draft", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "API Rate Limits",
        content: "# Rate Limits\n\n100 req/min",
        tags: ["architecture"],
      },
      dev.apiKey,
    );
    expect(status).toBe(201);
    expect(data.node.status).toBe("draft");
    // Should return resolved stewards
    expect(data.stewards).toBeDefined();
    expect(data.stewards.length).toBeGreaterThanOrEqual(1);
  });

  it("resolves stewards for a node", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/api-rate-limits/stewards`,
      undefined,
      dev.apiKey,
    );
    expect(status).toBe(200);
    expect(data.stewards.length).toBeGreaterThanOrEqual(1);
    // Jane should be resolved via tag: #architecture
    const jane = data.stewards.find(
      (s: any) => s.email === "jane@acme.com",
    );
    expect(jane).toBeDefined();
    expect(jane.source).toContain("tag");
  });

  it("tracks version on create", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/api-rate-limits/versions`,
      undefined,
      dev.apiKey,
    );
    expect(status).toBe(200);
    expect(data.versions.length).toBe(1);
    expect(data.versions[0].version).toBe(1);
    expect(data.versions[0].status).toBe("draft");
    expect(data.approvedVersion).toBeNull();
  });

  it("can submit for review", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/api-rate-limits/submit-review`,
      { note: "Please review the rate limit docs", priority: "high" },
      dev.apiKey,
    );
    expect(status).toBe(201);
    expect(data.review.status).toBe("pending");
    expect(data.review.priority).toBe("high");
    expect(data.stewards.length).toBeGreaterThanOrEqual(1);
  });

  it("shows pending review in queue", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/review-queue`,
      undefined,
      reviewer.apiKey,
    );
    expect(status).toBe(200);
    expect(data.requests.length).toBe(1);
    expect(data.requests[0].nodeId).toBe("nodes/api-rate-limits");
    expect(data.requests[0].priority).toBe("high");
  });

  it("steward can approve", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/api-rate-limits/approve`,
      { note: "Looks good" },
      reviewer.apiKey,
    );
    expect(status).toBe(200);
    expect(data.review.status).toBe("approved");
    expect(data.review.resolvedBy).toBe("jane@acme.com");
  });

  it("approved version is pinned", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/api-rate-limits/versions`,
      undefined,
      dev.apiKey,
    );
    expect(status).toBe(200);
    // approve() runs safePublishDocument, which bumps engine version 1→2 and
    // re-pins approved_version to the bumped value (see review-service.ts).
    // versions[0] is the new v=2 row, written by approve() with
    // status='published' so the DB mirrors the engine's terminal state.
    expect(data.approvedVersion).toBe(2);
    expect(data.versions[0].status).toBe("published");
  });

  it("review history is recorded", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/api-rate-limits/reviews`,
      undefined,
      dev.apiKey,
    );
    expect(status).toBe(200);
    expect(data.reviews.length).toBe(1);
    expect(data.reviews[0].status).toBe("approved");
    expect(data.reviews[0].resolutionNote).toBe("Looks good");
  });

  it("review queue is now empty", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/review-queue`,
      undefined,
      reviewer.apiKey,
    );
    expect(status).toBe(200);
    expect(data.requests.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rejection Workflow
// ═══════════════════════════════════════════════════════════════════════════

describe("governance: rejection workflow", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let dev: { apiKey: string; userId: string };
  let reviewer: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    dev = await registerUser(app, "dev@acme.com", "Dev");
    reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Review Vault" },
      dev.apiKey,
    );
    nestId = data.nest.id;

    // Grant reviewer write access
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "reviewer@acme.com", permission: "write" },
      dev.apiKey,
    );

    // Write stewards.yaml
    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `nest:
  - email: reviewer@acme.com, role: reviewer, can_approve: true
`,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, dev.apiKey);

    // Create and submit node
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Draft Doc", content: "Needs work" },
      dev.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/draft-doc/submit-review`,
      {},
      dev.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("rejection requires a note", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/draft-doc/reject`,
      {},
      reviewer.apiKey,
    );
    expect(status).toBe(400);
    expect(data.error).toContain("note");
  });

  it("steward can reject with note", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/draft-doc/reject`,
      { note: "Missing error codes section" },
      reviewer.apiKey,
    );
    expect(status).toBe(200);
    expect(data.review.status).toBe("rejected");
    expect(data.review.resolutionNote).toBe("Missing error codes section");
  });

  it("rejected version is tracked", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/draft-doc/versions`,
      undefined,
      dev.apiKey,
    );
    expect(status).toBe(200);
    expect(data.versions.length).toBeGreaterThanOrEqual(1);
    expect(data.versions[0].status).toBe("rejected");
    expect(data.approvedVersion).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Version Conflict Detection
// ═══════════════════════════════════════════════════════════════════════════

describe("governance: version conflicts", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string };
  let bob: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@acme.com", "Alice");
    bob = await registerUser(app, "bob@acme.com", "Bob");

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Conflict Vault" },
      alice.apiKey,
    );
    nestId = data.nest.id;

    // Share with Bob
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "bob@acme.com", permission: "write" },
      alice.apiKey,
    );

    // Create initial node
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Shared Doc", content: "Version 1 content" },
      alice.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("update without X-Base-Version succeeds (last-write-wins)", async () => {
    const { status, data } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/shared-doc`,
      { content: "Updated by Alice" },
      alice.apiKey,
    );
    expect(status).toBe(200);
    expect(data.version).toBe(2);
  });

  it("update with matching X-Base-Version succeeds", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/nodes/shared-doc`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bob.apiKey}`,
        "X-Base-Version": "2",
      },
      body: JSON.stringify({ content: "Updated by Bob" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.version).toBe(3);
  });

  it("update with stale X-Base-Version returns 409 with conflict info", async () => {
    // Alice updates (creating version 4)
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/shared-doc`,
      { content: "Alice's latest" },
      alice.apiKey,
    );

    // Bob tries with stale version 3
    const res = await app.request(`/nests/${nestId}/nodes/nodes/shared-doc`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bob.apiKey}`,
        "X-Base-Version": "3",
      },
      body: JSON.stringify({ content: "Bob's conflicting edit" }),
    });
    expect(res.status).toBe(409);

    const data = await res.json();
    expect(data.error).toBe("Version conflict");
    expect(data.your_version).toBe(3);
    expect(data.current_version).toBe(4);
    expect(data.updated_by).toBe("alice@acme.com");
    expect(data.rejected_content).toBe("Bob's conflicting edit");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Open Mode Without Stewards (Auto-Approve)
// ═══════════════════════════════════════════════════════════════════════════

describe("governance: open mode without stewards = auto-approve", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
  });

  afterAll(() => env.cleanup());

  it("node created without stewards.yaml is auto-approved", async () => {
    // Create nest (no stewards.yaml)
    const { data: nestData } = await jsonRequest(app, "POST", "/nests", {
      name: "Open Vault",
    });
    const nestId = nestData.nest.id;

    // Create node
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Quick Note",
        content: "No governance here",
      },
    );
    expect(status).toBe(201);
    // No-stewards path auto-publishes via engine, which writes
    // frontmatter.status = 'published' (distinct from steward-approved
    // 'approved'). See nodes/routes.ts auto-publish branch.
    expect(data.node.status).toBe("published");
    expect(data.stewards).toBeUndefined();
  });

  it("approved version is pinned for auto-approved nodes", async () => {
    const { data: nestData } = await jsonRequest(app, "GET", "/nests");
    const nestId = nestData.nests[0].id;

    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/quick-note/versions`,
    );
    expect(data.approvedVersion).toBe(1);
    // Auto-publish writes versions row with status='published'.
    expect(data.versions[0].status).toBe("published");
  });

  it("updates to auto-approved nodes are also auto-approved", async () => {
    const { data: nestData } = await jsonRequest(app, "GET", "/nests");
    const nestId = nestData.nests[0].id;

    const { data } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/quick-note`,
      { content: "Updated content" },
    );
    expect(data.version).toBe(2);

    const { data: versionData } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/quick-note/versions`,
    );
    expect(versionData.approvedVersion).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Non-Steward Cannot Approve
// ═══════════════════════════════════════════════════════════════════════════

describe("governance: permission enforcement", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let dev: { apiKey: string };
  let outsider: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    dev = await registerUser(app, "dev@acme.com", "Dev");
    outsider = await registerUser(app, "outsider@acme.com", "Outsider");

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Strict Vault" },
      dev.apiKey,
    );
    nestId = data.nest.id;

    // Share with outsider as writer (outsider can create nodes but not approve)
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "outsider@acme.com", permission: "write" },
      dev.apiKey,
    );

    // Add stewards.yaml — only dev@acme.com can approve
    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `nest:
  - email: dev@acme.com, role: admin, can_approve: true
`,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, dev.apiKey);

    // Outsider creates a node and submits
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Outsider Doc", content: "Please review" },
      outsider.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/outsider-doc/submit-review`,
      {},
      outsider.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("non-steward cannot approve", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/outsider-doc/approve`,
      { note: "Trying to self-approve" },
      outsider.apiKey,
    );
    expect(status).toBe(403);
    expect(data.error).toContain("steward");
  });

  it("steward can approve", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/outsider-doc/approve`,
      { note: "Approved by admin" },
      dev.apiKey,
    );
    expect(status).toBe(200);
    expect(data.review.status).toBe("approved");
  });
});
