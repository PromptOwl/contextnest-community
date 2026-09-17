/**
 * GET /nests/:nestId/nodes/:nodeId?approved_only=1 serves the approved body to
 * a caller who could see the draft — the read behind "Preview as reader"
 * (CU-wdqcq027fw), so an owner previewing the public reader sees the same
 * text a visitor gets rather than their own unapproved edit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@preview.test", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Preview" }, owner.apiKey);
  nestId = nest.data.nest.id;

  // Stewardship off: the first write auto-approves as version 1.
  await jsonRequest(
    app, "POST", `/nests/${nestId}/nodes`,
    { title: "Guide", content: "# Guide\n\nApproved text." }, owner.apiKey,
  );
  // Stewardship on: the next edit is a draft on top of the approved version.
  await jsonRequest(
    app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey,
  );
  await jsonRequest(
    app, "PATCH", `/nests/${nestId}/nodes/nodes/guide`,
    { content: "# Guide\n\nDraft text nobody approved." }, owner.apiKey,
  );
}, 30000);

afterAll(() => env.cleanup());

describe("GET node ?approved_only=1", () => {
  it("the owner normally reads their draft", async () => {
    const { status, data } = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes/nodes/guide`, undefined, owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.node.content).toContain("Draft text");
  });

  it("with approved_only the same owner reads the approved body and version", async () => {
    const { status, data } = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes/nodes/guide?approved_only=1`, undefined, owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.node.content).toContain("Approved text");
    expect(data.node.content).not.toContain("Draft text");
    expect(data.node.version).toBe(1);
    expect(data.node.status).toBe("published");
  });
});
