import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

// A reviewer-steward who reaches a PUBLIC nest only via visibility (NOT a
// collaborator) must still get full review affordances. Regression for the
// dogfood bug where the Review button + queue were hidden for such a user even
// though the in-document approve/reject showed (the two surfaces derived review
// rights from different sources). The /review-queue now stamps each request
// with an authoritative `canReview` so the UI stops re-deriving steward scope.
describe("public-nest reviewer steward: review-queue canReview", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string; email: string };
  let reviewer: { apiKey: string; userId: string; email: string };
  let nestId: string;
  let nodeId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["owner@acme.com"] });
    owner = await registerUser(app, "owner@acme.com", "Owner");
    reviewer = await registerUser(app, "rev@acme.com", "Rev");

    const { data: nestData } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Public Vault" },
      owner.apiKey,
    );
    nestId = nestData.nest.id;

    // Owner authors the doc. Reviewer is intentionally NOT a collaborator.
    const { data: nodeData } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Spec Doc", content: "# Spec\n\nfirst draft", tags: ["architecture"] },
      owner.apiKey,
    );
    nodeId = nodeData.node.id;

    // Reviewer steward, tag-scoped on #architecture — reaches the nest only via
    // public visibility, never a collaborator grant.
    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `version: 1\ntags:\n  #architecture:\n    - email: rev@acme.com, role: reviewer, can_approve: true\n`,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);

    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { stewardship_enabled: true },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public", acknowledge_public: true },
      owner.apiKey,
    );

    // Owner submits the doc for review.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/submit-review`,
      { note: "please review", priority: "high" },
      owner.apiKey,
    );
  }, 30000);

  afterAll(() => env.cleanup());

  it("reviewer sees the request AND can review it (canReview=true)", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/review-queue`,
      undefined,
      reviewer.apiKey,
    );
    expect(status).toBe(200);
    expect(data.requests.length).toBe(1);
    const req = data.requests[0];
    expect(req.nodeId).toBe(nodeId);
    expect(req.canReview).toBe(true);
  });

  it("the submitter (owner) sees it but cannot review it — SoD (canReview=false)", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/review-queue`,
      undefined,
      owner.apiKey,
    );
    expect(data.requests.length).toBe(1);
    // Owner submitted it; separation-of-duties blocks self-approval (nest does
    // not allow self-approve), so canReview must be false.
    expect(data.requests[0].canReview).toBe(false);
  });

  it("reviewer can actually approve (capability matches the flag)", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/approve`,
      { note: "looks good" },
      reviewer.apiKey,
    );
    expect(status).toBe(200);
    expect(data.review.status).toBe("approved");
    expect(data.review.resolvedBy).toBe("rev@acme.com");
  });
});
