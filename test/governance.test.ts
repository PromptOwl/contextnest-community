import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
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
    // lead is the server (super) admin — only they can manage the roster.
    app = await createTestApp("key", { superAdmins: ["lead@acme.com"] });
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
  }, 30000);

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
    // dev owns the nest AND is the server admin syncing the roster.
    app = await createTestApp("key", { superAdmins: ["dev@acme.com"] });
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
    // dev is the super admin — steward sync is super-admin-gated (see app.ts),
    // so without this the stewards.yaml below never syncs and dev holds no
    // approve role.
    app = await createTestApp("key", { superAdmins: ["dev@acme.com"] });
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

// ─── Owner self-approve is gated by allow_self_approve ─────────────────
// SoD applies to the owner's OWN submissions too: the owner can approve
// others' work freely, but approving a version they themselves submitted
// requires the nest's allow_self_approve flag. (Supersedes the
// unconditional owner bypass from CU-86ahn99dg.)
describe("governance: nest owner self-approve respects allow_self_approve", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@solo.test", "Owner");

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Solo Nest" },
      owner.apiKey,
    );
    nestId = data.nest.id;

    // Enable stewardship so submitted docs go through review.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { stewardship_enabled: true },
      owner.apiKey,
    );

    // Stewards.yaml making the owner a nest-scope reviewer. Without this,
    // canUserApprove would 403 on "no stewards configured" before we
    // could get to the self-approve case.
    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `version: 1
nest:
  - email: owner@solo.test, role: reviewer, can_approve: true
`,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards/sync`,
      {},
      owner.apiKey,
    );

    // Owner authors a node + submits it for review.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Seed Doc",
        content: "# Seed Doc\n\nFirst document while seeding the nest.",
      },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/seed-doc/submit-review`,
      { note: "seeding the nest" },
      owner.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("owner is blocked from approving their own submission while flag off", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/seed-doc/approve`,
      { note: "approving my own seed doc" },
      owner.apiKey,
    );
    expect(status).toBe(403);
  });

  it("owner can approve their own submission once flag is on", async () => {
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { allow_self_approve: true },
      owner.apiKey,
    );
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/seed-doc/approve`,
      { note: "approving my own seed doc" },
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.review.status).toBe("approved");
  });
});

// ─── Per-nest allow_self_approve flag (owner-approval switch) ──────────
// allow_self_approve gates the OWNER's approval power, not a generic
// self-approve bypass:
//   flag OFF -> approvals go to assigned reviewers; the owner can't approve
//              via ownership alone (own OR others'). Reviewers approve
//              teammates' work but never their own.
//   flag ON  -> the owner may approve anything, including their own
//              submissions (seeding). Reviewers are unchanged; editors never.
// An owner who is ALSO a reviewer/admin steward approves teammates' work via
// that role regardless of the flag (covered by the owner-self-approve block).
describe("governance: per-nest allow_self_approve flag", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let superAdmin: { apiKey: string; userId: string };
  let owner: { apiKey: string; userId: string };
  let reviewer: { apiKey: string; userId: string };
  let editor: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    // owner is a BARE nest owner — not a super-admin and not a steward. A
    // separate super admin performs the steward sync (it's super-admin-gated),
    // so the reviewer role is real while the owner stays ungoverned-by-steward.
    app = await createTestApp("key", { superAdmins: ["super@team.test"] });
    superAdmin = await registerUser(app, "super@team.test", "Super");
    owner = await registerUser(app, "owner@team.test", "Owner");
    reviewer = await registerUser(app, "rev@team.test", "Rev");
    // 4 users exceed REGISTER_LIMIT (3/hr per IP) — clear the bucket first.
    await resetAuthRateLimit();
    editor = await registerUser(app, "ed@team.test", "Ed");

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Bootstrap Nest" },
      owner.apiKey,
    );
    nestId = data.nest.id;

    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { stewardship_enabled: true },
      owner.apiKey,
    );

    // rev is a nest-scope reviewer; ed only has write (no approve role).
    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `version: 1
nest:
  - email: rev@team.test, role: reviewer, can_approve: true
`,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "rev@team.test", permission: "write" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "ed@team.test", permission: "write" },
      owner.apiKey,
    );
    // Steward sync needs BOTH super-admin (middleware) AND nest access (route
    // 404s non-members). Add the super admin as an admin collaborator so it can
    // reach the nest; the owner itself stays bare (no steward/super role).
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "super@team.test", permission: "admin" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards/sync`,
      {},
      superAdmin.apiKey,
    );

    // Authors submit their own docs: rev-doc (reviewer), ed-doc (editor),
    // owner-doc (owner), rev2-doc (reviewer — kept pending for the flag-on case).
    for (const [author, title] of [
      [reviewer, "Rev Doc"],
      [editor, "Ed Doc"],
      [owner, "Owner Doc"],
      [reviewer, "Rev2 Doc"],
    ] as const) {
      const slug = title.toLowerCase().replace(/ /g, "-");
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title, content: `# ${title}\n\nDraft.` },
        author.apiKey,
      );
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes/nodes/${slug}/submit-review`,
        { note: "seeding" },
        author.apiKey,
      );
    }
  });

  afterAll(() => env.cleanup());

  // ── Flag OFF (default) ──────────────────────────────────────────────
  it("reviewer cannot approve their own submission (flag off)", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/rev-doc/approve`,
      { note: "self approve" },
      reviewer.apiKey,
    );
    expect(status).toBe(403);
  });

  it("editor cannot approve at all (flag off)", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/ed-doc/approve`,
      { note: "self approve" },
      editor.apiKey,
    );
    expect(status).toBe(403);
  });

  it("reviewer can approve a teammate's submission (flag off)", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/ed-doc/approve`,
      { note: "reviewing the editor's draft" },
      reviewer.apiKey,
    );
    expect(status).toBe(200);
    expect(data.review.status).toBe("approved");
  });

  it("bare owner cannot approve a teammate's submission while flag off", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/rev-doc/approve`,
      { note: "owner approving" },
      owner.apiKey,
    );
    expect(status).toBe(403);
  });

  it("bare owner cannot approve their own submission while flag off", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/owner-doc/approve`,
      { note: "owner self approve" },
      owner.apiKey,
    );
    expect(status).toBe(403);
  });

  it("settings round-trips allow_self_approve", async () => {
    const { data } = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { allow_self_approve: true },
      owner.apiKey,
    );
    expect(data.allow_self_approve).toBe(true);

    const { data: read } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/settings`,
      undefined,
      owner.apiKey,
    );
    expect(read.allow_self_approve).toBe(true);
  });

  // ── Flag ON ─────────────────────────────────────────────────────────
  it("owner can approve a teammate's submission once flag is on", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/rev-doc/approve`,
      { note: "owner approving" },
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.review.status).toBe("approved");
  });

  it("owner can approve their own submission once flag is on", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/owner-doc/approve`,
      { note: "owner self approve" },
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.review.status).toBe("approved");
  });

  it("reviewer still cannot self-approve even with flag on", async () => {
    // The flag is the owner's switch; it never loosens SoD for a non-owner.
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/rev2-doc/approve`,
      { note: "self approve" },
      reviewer.apiKey,
    );
    expect(status).toBe(403);
  });
});
